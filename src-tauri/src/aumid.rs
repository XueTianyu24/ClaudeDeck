//! 让免安装 / dev 模式下的 WinRT toast 通知来源显示应用名而非 "PowerShell"。
//! 原理：在开始菜单写一个带 System.AppUserModel.ID 的快捷方式，并把当前进程
//! 绑到同一个 AUMID。AUMID 必须等于 tauri.conf.json 的 identifier。
//! （安装版由安装器自动注册，本函数只为免安装 / dev 场景补这一步。）

// 非 Windows 下调用点（run() 里）被 `#[cfg(windows)]` 整段排除，此 stub 无人调用，
// 加 allow 抑制 dead_code 告警，保持 macOS / Linux 编译零警告。
#[cfg(not(windows))]
#[allow(dead_code)]
pub fn ensure_aumid_shortcut(
    _app_id: &str,
    _display_name: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    Ok(())
}

#[cfg(windows)]
pub fn ensure_aumid_shortcut(
    app_id: &str,
    display_name: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    use std::path::PathBuf;
    use windows::core::{Interface, HSTRING};
    use windows::Win32::Storage::EnhancedStorage::PKEY_AppUserModel_ID;
    use windows::Win32::System::Com::StructuredStorage::PROPVARIANT;
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, IPersistFile, CLSCTX_INPROC_SERVER,
        COINIT_APARTMENTTHREADED,
    };
    use windows::Win32::UI::Shell::PropertiesSystem::IPropertyStore;
    use windows::Win32::UI::Shell::{
        IShellLinkW, SetCurrentProcessExplicitAppUserModelID, ShellLink,
    };

    // 每次启动都把本进程绑到 AUMID —— 即使快捷方式已存在也要做。失败非致命。
    let app_id_h = HSTRING::from(app_id);
    unsafe {
        let _ = SetCurrentProcessExplicitAppUserModelID(&app_id_h);
    }

    // %APPDATA%\Microsoft\Windows\Start Menu\Programs\<display_name>.lnk
    let appdata = std::env::var("APPDATA")?;
    let lnk_path = PathBuf::from(appdata)
        .join(r"Microsoft\Windows\Start Menu\Programs")
        .join(format!("{display_name}.lnk"));

    // 幂等：快捷方式已存在则跳过创建（AUMID 上面已绑定）。
    if lnk_path.exists() {
        return Ok(());
    }

    unsafe {
        // COM 初始化：可重复调用；已初始化 / 线程已是 MTA 时返回非 S_OK，均不影响后续，忽略。
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);

        let exe = std::env::current_exe()?;
        let exe_h = HSTRING::from(exe.as_os_str());

        // CLSID_ShellLink -> IShellLinkW
        let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER)?;
        link.SetPath(&exe_h)?;
        if let Some(dir) = exe.parent() {
            let _ = link.SetWorkingDirectory(&HSTRING::from(dir.as_os_str()));
        }
        let _ = link.SetIconLocation(&exe_h, 0); // 图标用 exe 自带的第 0 个

        // 把 AUMID 写进快捷方式的属性存储。
        let store: IPropertyStore = link.cast()?;
        let pv = PROPVARIANT::from(app_id); // VT_BSTR
        store.SetValue(&PKEY_AppUserModel_ID, &pv)?;
        store.Commit()?;

        // 落盘 .lnk
        if let Some(parent) = lnk_path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let persist: IPersistFile = link.cast()?;
        persist.Save(&HSTRING::from(lnk_path.as_os_str()), true)?;
    }

    Ok(())
}
