use tauri::{Emitter, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
pub struct Features {
    pub shortcut: String,
    pub tray: bool,
}
pub fn focus(app: &tauri::AppHandle) {
    #[cfg(target_os = "macos")]
    let _ = app.show();
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
        let _ = w.emit("focus-search", ());
    }
}
pub fn hide<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> tauri::Result<()> {
    // orderOut on a fullscreen NSWindow leaves its Space empty. AppKit's
    // application hide/unhide handles the Space and preserves fullscreen state.
    #[cfg(target_os = "macos")]
    return app.hide();
    #[cfg(not(target_os = "macos"))]
    {
        if let Some(w) = app.get_webview_window("main") {
            w.hide()?;
        }
        Ok(())
    }
}

pub fn hide_after_close<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    _window: &tauri::Window<R>,
) -> tauri::Result<()> {
    #[cfg(target_os = "macos")]
    if _window.is_fullscreen().unwrap_or(false) {
        // AppKit's fullscreen animation takes about a second. Tao clears its
        // fullscreen flag as soon as the exit is requested, before that
        // animation ends, so wait for the flag and then allow the transition
        // to finish before hiding the application.
        _window.set_fullscreen(false)?;
        let app = app.clone();
        let window = _window.clone();
        std::thread::spawn(move || {
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
            loop {
                match window.is_fullscreen() {
                    Ok(false) => {
                        std::thread::sleep(std::time::Duration::from_millis(1100));
                        break;
                    }
                    Ok(true) if std::time::Instant::now() < deadline => {
                        std::thread::sleep(std::time::Duration::from_millis(50));
                    }
                    Ok(true) => {
                        eprintln!("Fullscreen exit did not complete before hiding the app");
                        break;
                    }
                    Err(error) => {
                        eprintln!("Could not check fullscreen state before hiding: {error}");
                        break;
                    }
                }
            }

            let app_to_hide = app.clone();
            if let Err(error) = app.run_on_main_thread(move || {
                if let Err(error) = app_to_hide.hide() {
                    eprintln!("Could not hide main window: {error}");
                }
            }) {
                eprintln!("Could not schedule app hide on the main thread: {error}");
            }
        });
        return Ok(());
    }

    hide(app)
}

pub fn install(app: &mut tauri::App) -> Features {
    let shortcut = match app.handle().plugin(
        tauri_plugin_global_shortcut::Builder::new()
            .with_handler(|app, _, event| {
                if event.state() == ShortcutState::Pressed {
                    focus(app);
                }
            })
            .build(),
    ) {
        Ok(()) => match app.global_shortcut().register("Control+Alt+Q") {
            Ok(()) => "Ctrl + Alt + Q".into(),
            Err(_) => "快捷键被占用，仍可从托盘打开".into(),
        },
        Err(_) => "系统快捷键暂不可用".into(),
    };
    let tray = (|| -> tauri::Result<()> {
        use tauri::menu::{Menu, MenuItem};
        use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
        let show = MenuItem::with_id(app, "show", "打开题库", true, None::<&str>)?;
        let hide_item = MenuItem::with_id(app, "hide", "收起窗口", true, None::<&str>)?;
        let quit = MenuItem::with_id(app, "quit", "退出题库", true, None::<&str>)?;
        let menu = Menu::with_items(app, &[&show, &hide_item, &quit])?;
        let (icon, template) = crate::tray_style::current_icon(app.handle())?;
        let builder = TrayIconBuilder::with_id(crate::tray_style::TRAY_ID)
            .icon(icon)
            .icon_as_template(template)
            .tooltip("题库 · Ctrl + Alt + Q 搜索")
            .menu(&menu)
            .show_menu_on_left_click(false)
            .on_menu_event(|app, event| match event.id.as_ref() {
                "show" => focus(app),
                "hide" => {
                    if let Err(error) = hide(app) {
                        eprintln!("Could not hide main window: {error}");
                    }
                }
                "quit" => app.exit(0),
                _ => {}
            })
            .on_tray_icon_event(|tray, event| {
                if let TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                } = event
                {
                    focus(tray.app_handle());
                }
            });
        builder.build(app)?;
        Ok(())
    })()
    .is_ok();
    Features { shortcut, tray }
}
