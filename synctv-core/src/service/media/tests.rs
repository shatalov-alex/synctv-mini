use super::*;

fn direct_url_media_source_config(url: impl Into<String>) -> crate::models::MediaSourceConfig {
    crate::models::MediaSourceConfig::DirectUrl(crate::models::DirectUrlMediaSourceConfig {
        playback_kind: None,
        duration_seconds: None,
        proxy_mode: crate::models::PlaybackProxyMode::Auto,
        medias: vec![crate::models::DirectUrlMediaResourceConfig {
            name: String::new(),
            url: url.into(),
            headers: std::collections::HashMap::new(),
            format: String::new(),
            expires_at: None,
        }],
        default_media_index: None,
        subtitles: Vec::new(),
        default_subtitle_index: None,
        danmakus: Vec::new(),
        default_danmaku_index: None,
    })
}

#[test]
fn media_edit_requires_matching_creator() {
    let creator_id = UserId::expect_positive(10);
    let media = Media {
        id: MediaId::expect_positive(11),
        playlist_id: None,
        room_id: RoomId::expect_positive(12),
        creator_id: Some(creator_id),
        name: "Owned".to_string(),
        description: String::new(),
        position: 1.0,
        source_provider: SourceProvider::DirectUrl,
        provider_instance_name: None,
        source_config: direct_url_media_source_config("https://example.com/video.mp4"),
        added_at: crate::SystemClock.now(),
        updated_at: crate::SystemClock.now(),
        version: 1,
        cover_file_reference_id: None,
        thumbnail_file_reference_id: None,
    };

    assert!(ensure_media_creator_can_edit(&media, &creator_id).is_ok());

    let other_user_id = UserId::expect_positive(13);
    assert!(matches!(
        ensure_media_creator_can_edit(&media, &other_user_id),
        Err(Error::Authorization(_))
    ));

    let mut unowned_media = media;
    unowned_media.creator_id = None;
    assert!(matches!(
        ensure_media_creator_can_edit(&unowned_media, &creator_id),
        Err(Error::Authorization(_))
    ));
}

mod replacement_source {
    use super::*;
    use crate::models::{MediaSourceConfig, PlaybackKind, PlaybackProxyMode};

    fn direct(
        proxy_mode: PlaybackProxyMode,
        duration_seconds: Option<f64>,
        playback_kind: Option<PlaybackKind>,
    ) -> MediaSourceConfig {
        let MediaSourceConfig::DirectUrl(mut config) =
            direct_url_media_source_config("https://media.example.com/a.mp4")
        else {
            unreachable!("helper builds a direct URL");
        };
        config.proxy_mode = proxy_mode;
        config.duration_seconds = duration_seconds;
        config.playback_kind = playback_kind;
        MediaSourceConfig::DirectUrl(config)
    }

    fn replaced(
        previous: &MediaSourceConfig,
        mut replacement: MediaSourceConfig,
        default_proxy_mode: Option<PlaybackProxyMode>,
    ) -> crate::models::DirectUrlMediaSourceConfig {
        keep_direct_url_settings_on_replacement(previous, &mut replacement, default_proxy_mode);
        match replacement {
            MediaSourceConfig::DirectUrl(config) => config,
            other => panic!("unexpected source {other:?}"),
        }
    }

    #[test]
    fn omitted_settings_stay_as_they_were() {
        let config = replaced(
            &direct(PlaybackProxyMode::DirectOnly, Some(5400.0), None),
            direct(PlaybackProxyMode::Auto, None, None),
            Some(PlaybackProxyMode::Only),
        );
        assert_eq!(config.proxy_mode, PlaybackProxyMode::DirectOnly);
        assert_eq!(config.duration_seconds, Some(5400.0));
    }

    #[test]
    fn media_without_a_mode_takes_the_server_default() {
        let config = replaced(
            &direct(PlaybackProxyMode::Auto, None, None),
            direct(PlaybackProxyMode::Auto, None, None),
            Some(PlaybackProxyMode::Only),
        );
        assert_eq!(config.proxy_mode, PlaybackProxyMode::Only);
        let config = replaced(
            &direct(PlaybackProxyMode::Auto, None, None),
            direct(PlaybackProxyMode::Auto, None, None),
            None,
        );
        assert_eq!(config.proxy_mode, PlaybackProxyMode::Auto);
    }

    #[test]
    fn explicit_settings_win() {
        let config = replaced(
            &direct(PlaybackProxyMode::DirectOnly, Some(5400.0), None),
            direct(PlaybackProxyMode::Prefer, Some(6000.0), None),
            Some(PlaybackProxyMode::Only),
        );
        assert_eq!(config.proxy_mode, PlaybackProxyMode::Prefer);
        assert_eq!(config.duration_seconds, Some(6000.0));
    }

    #[test]
    fn a_live_replacement_gets_no_duration() {
        let config = replaced(
            &direct(PlaybackProxyMode::Only, Some(5400.0), None),
            direct(PlaybackProxyMode::Auto, None, Some(PlaybackKind::Live)),
            None,
        );
        assert_eq!(config.duration_seconds, None);
        assert_eq!(config.proxy_mode, PlaybackProxyMode::Only);
    }
}
