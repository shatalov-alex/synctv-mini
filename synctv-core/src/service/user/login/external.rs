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

/// Which account requests authenticated by the service API key act as (`service_api.act_as`).
#[derive(Debug, Clone, Copy)]
pub enum ServiceApiActAs<'a> {
    /// The Telegram admin's account (`telegram.admin_user_id`), resolved like the bot does.
    TelegramAdmin {
        admin_telegram_user_id: i64,
        admin_username: &'a str,
    },
    Username(&'a str),
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

    /// The local account the configured Telegram admin acts as in the bot: the account their
    /// Telegram id is mapped to (set by Mini App sign-in) if it is an active admin, otherwise
    /// `admin_username` if that is an active admin. `None` if neither qualifies.
    pub async fn find_telegram_admin_user(
        &self,
        admin_telegram_user_id: i64,
        admin_username: &str,
    ) -> Result<Option<User>> {
        let usable =
            |user: &User| user.is_admin_or_above() && Self::validate_user_access(user).is_ok();
        let identities = TelegramIdentityRepository::new(self.repository.pool().clone());
        if let Some(user_id) = identities.find_user_id(admin_telegram_user_id).await? {
            if let Some(user) = self.repository.get_by_id(&user_id).await?.filter(usable) {
                return Ok(Some(user));
            }
        }
        if admin_username.is_empty() {
            return Ok(None);
        }
        Ok(self
            .repository
            .get_by_username(admin_username)
            .await?
            .filter(usable))
    }

    /// The account the service API key acts as, or `None` if it does not resolve to an
    /// active account. `TelegramAdmin` is the same account the Telegram admin acts as in the
    /// Mini App and the bot, so rooms created through the key are theirs to manage too.
    pub async fn find_service_api_user(
        &self,
        act_as: &ServiceApiActAs<'_>,
    ) -> Result<Option<User>> {
        match act_as {
            ServiceApiActAs::TelegramAdmin {
                admin_telegram_user_id,
                admin_username,
            } => {
                if *admin_telegram_user_id == 0 {
                    return Ok(None);
                }
                self.find_telegram_admin_user(*admin_telegram_user_id, admin_username)
                    .await
            }
            ServiceApiActAs::Username(username) => {
                let username = Self::canonical_username(username);
                if username.is_empty() {
                    return Ok(None);
                }
                Ok(self
                    .repository
                    .get_by_username(&username)
                    .await?
                    .filter(|user| Self::validate_user_access(user).is_ok()))
            }
        }
    }

    /// Create the account a newly paired TV signs in as: `tv_<id>`, plain user role, no
    /// password or email, so tokens issued through pairing are its only way in.
    pub async fn create_tv_user(&self) -> Result<User> {
        let username = format!("tv_{}", synctv_common::snanoid!(10).to_lowercase());
        self.repository
            .create(&User::new(username, SignupMethod::AdminCreated))
            .await
    }

    /// Issue tokens for a paired TV, bound to its `tv_devices` row.
    pub async fn login_with_tv_device_with_control(
        &self,
        user_id: &UserId,
        tv_device_id: i64,
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
            AuthFactorMethod::TvPairing,
            TokenCredentialBinding::TvDevice {
                device_id: tv_device_id,
            },
            &format!("tv_device:{tv_device_id}"),
            client_ip,
            control,
        )
        .await
    }

    /// Brute-force gate for claiming TV pairing codes: per claiming user and per IP.
    pub async fn check_tv_pairing_claim_allowed_with_control(
        &self,
        claimer_id: &UserId,
        client_ip: Option<IpAddr>,
        control: Option<&ExecutionControl>,
    ) -> Result<()> {
        self.brute_force
            .check_subject_key_allowed_with_control(
                &Self::tv_pairing_claim_key(claimer_id),
                client_ip,
                control,
            )
            .await
    }

    /// Count a wrong or expired pairing code against the claiming user and IP.
    pub async fn record_tv_pairing_claim_failure_with_control(
        &self,
        claimer_id: &UserId,
        client_ip: Option<IpAddr>,
        control: Option<&ExecutionControl>,
    ) -> Result<()> {
        self.brute_force
            .record_subject_key_failure_with_control(
                &Self::tv_pairing_claim_key(claimer_id),
                client_ip,
                control,
            )
            .await
    }

    fn tv_pairing_claim_key(claimer_id: &UserId) -> String {
        format!("tv_pairing_claim:{claimer_id}")
    }
}
