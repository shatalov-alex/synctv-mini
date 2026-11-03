use std::net::IpAddr;

use synctv_common::ExecutionControl;

use crate::{
    models::{SignupMethod, User, UserId},
    repository::TelegramIdentityRepository,
    service::{
        auth::{verify_telegram_init_data, TelegramInitData},
        user::{
            session_types::{AuthFactorMethod, AuthenticatedLogin},
            UserService,
        },
        TokenCredentialBinding,
    },
    Error, Result,
};

/// Who may sign in through the Telegram Mini App as an administrator.
#[derive(Debug, Clone)]
pub struct TelegramAdminLogin<'a> {
    pub bot_token: &'a str,
    pub admin_telegram_user_id: i64,
    /// Local account the admin's Telegram id signs in as; must be admin or root.
    pub admin_username: &'a str,
    pub init_data_max_age_secs: i64,
}

impl UserService {
    /// Sign the configured Telegram admin in from Mini App `init_data`.
    ///
    /// Verifies the signature and freshness, requires the Telegram id to equal
    /// `admin_telegram_user_id`, maps it to `admin_username` (unlinking any other Telegram
    /// account previously mapped to that user), and issues tokens bound to the mapping.
    pub async fn login_with_telegram_admin_with_control(
        &self,
        init_data: &str,
        login: &TelegramAdminLogin<'_>,
        client_ip: Option<IpAddr>,
        control: Option<&ExecutionControl>,
    ) -> Result<AuthenticatedLogin> {
        let verified = self
            .verify_telegram_launch_with_control(
                init_data,
                login.bot_token,
                login.init_data_max_age_secs,
                client_ip,
                control,
            )
            .await?;
        let brute_force_key = format!("telegram:{}", verified.user_id);
        if login.admin_telegram_user_id == 0 || verified.user_id != login.admin_telegram_user_id {
            self.record_external_login_failure_with_control(
                &brute_force_key,
                false,
                client_ip,
                control,
            )
            .await?;
            return Err(Error::Authentication("Authentication failed".to_string()));
        }

        let user = self
            .repository
            .get_by_username(login.admin_username)
            .await?
            .filter(crate::models::User::is_admin_or_above)
            .ok_or_else(|| {
                tracing::error!(
                    username = login.admin_username,
                    "telegram.admin_username is not an existing admin account"
                );
                Error::Authentication("Authentication failed".to_string())
            })?;

        let identities = TelegramIdentityRepository::new(self.repository.pool().clone());
        identities
            .upsert(
                verified.user_id,
                &user.id,
                &verified.first_name,
                verified.username.as_deref(),
            )
            .await?;
        identities
            .delete_others_for_user(&user.id, verified.user_id)
            .await?;

        self.login_with_verified_telegram_with_control(
            &user.id,
            verified.user_id,
            &brute_force_key,
            client_ip,
            control,
        )
        .await
    }

    pub(crate) async fn check_passkey_discoverable_login_allowed_with_control(
        &self,
        client_ip: Option<IpAddr>,
        control: Option<&ExecutionControl>,
    ) -> Result<()> {
        self.brute_force
            .check_ip_allowed_with_control(client_ip, control)
            .await
    }

    pub(crate) async fn check_external_login_allowed_with_control(
        &self,
        brute_force_key: &str,
        client_ip: Option<IpAddr>,
        control: Option<&ExecutionControl>,
    ) -> Result<()> {
        self.brute_force
            .check_allowed_with_control(brute_force_key, client_ip, control)
            .await
    }

    pub(crate) async fn record_passkey_discoverable_login_failure_with_control(
        &self,
        client_ip: Option<IpAddr>,
        control: Option<&ExecutionControl>,
    ) -> Result<()> {
        self.brute_force
            .record_ip_failure_with_control(client_ip, control)
            .await
    }

    pub async fn record_external_login_failure_with_control(
        &self,
        brute_force_key: &str,
        user_existed: bool,
        client_ip: Option<IpAddr>,
        control: Option<&ExecutionControl>,
    ) -> Result<()> {
        self.record_login_failure_for_bruteforce(
            brute_force_key,
            user_existed,
            client_ip,
            control,
            "external",
        )
        .await
    }

    pub async fn login_with_verified_external_credential_with_control(
        &self,
        user_id: &UserId,
        credential_id: &[u8],
        brute_force_key: &str,
        client_ip: Option<IpAddr>,
        control: Option<&ExecutionControl>,
    ) -> Result<AuthenticatedLogin> {
        let user = self
            .repository
            .get_by_id(user_id)
            .await?
            .ok_or_else(|| Error::Authentication("Authentication failed".to_string()))?;

        self.complete_authenticated_login_with_control(
            user,
            AuthFactorMethod::WebAuthn,
            TokenCredentialBinding::WebAuthn {
                credential_id: credential_id.to_vec(),
            },
            brute_force_key,
            client_ip,
            control,
        )
        .await
    }

    /// Verify Mini App `init_data` from any Telegram user (signature and freshness only).
    pub async fn verify_telegram_launch_with_control(
        &self,
        init_data: &str,
        bot_token: &str,
        max_age_secs: i64,
        client_ip: Option<IpAddr>,
        control: Option<&ExecutionControl>,
    ) -> Result<TelegramInitData> {
        self.brute_force
            .check_ip_allowed_with_control(client_ip, control)
            .await?;
        let now = crate::SystemClock.now().timestamp();
        match verify_telegram_init_data(init_data, bot_token, now, max_age_secs) {
            Ok(verified) => Ok(verified),
            Err(error) => {
                self.brute_force
                    .record_ip_failure_with_control(client_ip, control)
                    .await?;
                Err(error)
            }
        }
    }

    /// The user mapped to this Telegram account, creating a plain account (`tg_<id>`, no
    /// password or email, so it can only sign in through Telegram) on first sight.
    pub async fn find_or_create_telegram_user(&self, verified: &TelegramInitData) -> Result<User> {
        let identities = TelegramIdentityRepository::new(self.repository.pool().clone());
        if let Some(user_id) = identities.find_user_id(verified.user_id).await? {
            let user = self
                .repository
                .get_by_id(&user_id)
                .await?
                .ok_or_else(|| Error::Authentication("Authentication failed".to_string()))?;
            Self::validate_user_access(&user)?;
            identities
                .upsert(
                    verified.user_id,
                    &user.id,
                    &verified.first_name,
                    verified.username.as_deref(),
                )
                .await?;
            return Ok(user);
        }

        let user = self
            .repository
            .create(&User::new(
                format!("tg_{}", verified.user_id),
                SignupMethod::AdminCreated,
            ))
            .await?;
        identities
            .upsert(
                verified.user_id,
                &user.id,
                &verified.first_name,
                verified.username.as_deref(),
            )
            .await?;
        Ok(user)
    }

    /// Issue tokens for a user whose Telegram account the caller has already verified and
    /// mapped in `auth_telegram_identities`.
    pub async fn login_with_verified_telegram_with_control(
        &self,
        user_id: &UserId,
        telegram_user_id: i64,
        brute_force_key: &str,
        client_ip: Option<IpAddr>,
        control: Option<&ExecutionControl>,
    ) -> Result<AuthenticatedLogin> {
        let user = self
            .repository
            .get_by_id(user_id)
            .await?
            .ok_or_else(|| Error::Authentication("Authentication failed".to_string()))?;

        self.complete_authenticated_login_with_control(
            user,
            AuthFactorMethod::Telegram,
            TokenCredentialBinding::Telegram { telegram_user_id },
            brute_force_key,
            client_ip,
            control,
        )
        .await
    }
}
