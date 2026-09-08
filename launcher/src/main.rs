#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
#![allow(unsafe_op_in_unsafe_fn)]

use std::{
    path::PathBuf,
    process::Command,
    ptr,
    sync::atomic::{AtomicIsize, Ordering},
};
use windows_sys::Win32::{
    Foundation::{GetLastError, HWND, LPARAM, LRESULT, WPARAM},
    Graphics::Gdi::{COLOR_WINDOW, DEFAULT_GUI_FONT, GetStockObject, HBRUSH, UpdateWindow},
    System::LibraryLoader::{
        GetModuleHandleW, LOAD_LIBRARY_SEARCH_SYSTEM32, SetDefaultDllDirectories, SetDllDirectoryW,
    },
    UI::WindowsAndMessaging::{
        BM_GETCHECK, BM_SETCHECK, BS_AUTOCHECKBOX, BS_PUSHBUTTON, CW_USEDEFAULT, CreateWindowExW,
        DefWindowProcW, DispatchMessageW, GetDlgItem, GetMessageW, HMENU, IDC_ARROW, LoadCursorW,
        MSG, PostQuitMessage, RegisterClassW, SW_SHOW, SendMessageW, SetWindowTextW, ShowWindow,
        TranslateMessage, WM_COMMAND, WM_DESTROY, WM_SETFONT, WNDCLASSW, WS_CHILD,
        WS_OVERLAPPEDWINDOW, WS_VISIBLE,
    },
};

const ID_EXCLUDE: usize = 1101;
const ID_MONITOR: usize = 1102;
const ID_NONE: usize = 1103;
const ID_FOLDER: usize = 1104;
const ID_FULLSCREEN: usize = 1105;
const ID_WATCHDOG: usize = 1106;
const ID_HARDEN_DLL_SEARCH: usize = 1107;
const ID_MODULE_MONITOR: usize = 1108;
const BST_CHECKED_VALUE: u32 = 1;

static STATUS_HANDLE: AtomicIsize = AtomicIsize::new(0);

fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

fn main() {
    unsafe {
        let launcher_hardening_status = harden_dll_search();
        let instance = GetModuleHandleW(ptr::null());
        if instance.is_null() {
            return;
        }

        let class_name = wide("OroWdaElectronLauncherWindow");
        let window_class = WNDCLASSW {
            lpfnWndProc: Some(window_proc),
            hInstance: instance,
            hCursor: LoadCursorW(ptr::null_mut(), IDC_ARROW),
            hbrBackground: (COLOR_WINDOW as isize + 1) as HBRUSH,
            lpszClassName: class_name.as_ptr(),
            ..Default::default()
        };
        if RegisterClassW(&window_class) == 0 {
            return;
        }

        let title = wide("OroResea Browser WDA Lab — OroNimbus controller");
        let hwnd = CreateWindowExW(
            0,
            class_name.as_ptr(),
            title.as_ptr(),
            WS_OVERLAPPEDWINDOW,
            CW_USEDEFAULT,
            CW_USEDEFAULT,
            820,
            635,
            ptr::null_mut(),
            ptr::null_mut(),
            instance,
            ptr::null(),
        );
        if hwnd.is_null() {
            return;
        }

        create_controls(hwnd, instance, &launcher_hardening_status);
        ShowWindow(hwnd, SW_SHOW);
        UpdateWindow(hwnd);

        let mut message = MSG::default();
        while GetMessageW(&mut message, ptr::null_mut(), 0, 0) > 0 {
            TranslateMessage(&message);
            DispatchMessageW(&message);
        }
    }
}

unsafe fn harden_dll_search() -> String {
    let default_ok = SetDefaultDllDirectories(LOAD_LIBRARY_SEARCH_SYSTEM32) != 0;
    let default_error = if default_ok { 0 } else { GetLastError() };
    let empty_directory = wide("");
    let directory_ok = SetDllDirectoryW(empty_directory.as_ptr()) != 0;
    let directory_error = if directory_ok { 0 } else { GetLastError() };

    if default_ok && directory_ok {
        "DLL search hardened (System32 default; current directory removed).".to_owned()
    } else {
        format!(
            "DLL search hardening incomplete (default error {default_error}; directory error {directory_error})."
        )
    }
}

unsafe fn create_controls(
    hwnd: HWND,
    instance: *mut core::ffi::c_void,
    launcher_hardening_status: &str,
) {
    let heading = create_child(
        hwnd,
        instance,
        "STATIC",
        "Launch a real Electron browser under a selected Windows Display Affinity mode",
        WS_CHILD | WS_VISIBLE,
        24,
        24,
        750,
        30,
        0,
    );
    let description = create_child(
        hwnd,
        instance,
        "STATIC",
        "The controller never protects itself. Each button starts OroNimbus.exe, and the Electron main process applies and reads WDA on its own BrowserWindow through a delay-loaded native module.",
        WS_CHILD | WS_VISIBLE,
        24,
        62,
        750,
        54,
        0,
    );
    let exclude = create_child(
        hwnd,
        instance,
        "BUTTON",
        "Launch EXCLUDE browser (0x11)",
        WS_CHILD | WS_VISIBLE | BS_PUSHBUTTON as u32,
        24,
        132,
        355,
        40,
        ID_EXCLUDE,
    );
    let monitor = create_child(
        hwnd,
        instance,
        "BUTTON",
        "Launch MONITOR browser (0x01)",
        WS_CHILD | WS_VISIBLE | BS_PUSHBUTTON as u32,
        399,
        132,
        355,
        40,
        ID_MONITOR,
    );
    let none = create_child(
        hwnd,
        instance,
        "BUTTON",
        "Launch unprotected browser (0x00)",
        WS_CHILD | WS_VISIBLE | BS_PUSHBUTTON as u32,
        24,
        188,
        355,
        40,
        ID_NONE,
    );
    let folder = create_child(
        hwnd,
        instance,
        "BUTTON",
        "Open OroNimbus scan target",
        WS_CHILD | WS_VISIBLE | BS_PUSHBUTTON as u32,
        399,
        188,
        355,
        40,
        ID_FOLDER,
    );
    let fullscreen = create_child(
        hwnd,
        instance,
        "BUTTON",
        "Launch browser in fullscreen (applies to EXCLUDE, MONITOR, and NONE)",
        WS_CHILD | WS_VISIBLE | BS_AUTOCHECKBOX as u32,
        24,
        244,
        730,
        28,
        ID_FULLSCREEN,
    );
    let watchdog = create_child(
        hwnd,
        instance,
        "BUTTON",
        "Enable 3-second WDA readback + reapply watchdog (observed MONITOR path)",
        WS_CHILD | WS_VISIBLE | BS_AUTOCHECKBOX as u32,
        24,
        278,
        730,
        28,
        ID_WATCHDOG,
    );
    let harden_dll_search = create_child(
        hwnd,
        instance,
        "BUTTON",
        "Apply System32-only DLL search hardening inside OroNimbus main process",
        WS_CHILD | WS_VISIBLE | BS_AUTOCHECKBOX as u32,
        24,
        312,
        730,
        28,
        ID_HARDEN_DLL_SEARCH,
    );
    let module_monitor = create_child(
        hwnd,
        instance,
        "BUTTON",
        "Monitor OroNimbus native module loads (heuristic)",
        WS_CHILD | WS_VISIBLE | BS_AUTOCHECKBOX as u32,
        24,
        346,
        730,
        28,
        ID_MODULE_MONITOR,
    );
    SendMessageW(watchdog, BM_SETCHECK, BST_CHECKED_VALUE as usize, 0);
    SendMessageW(
        harden_dll_search,
        BM_SETCHECK,
        BST_CHECKED_VALUE as usize,
        0,
    );
    SendMessageW(module_monitor, BM_SETCHECK, BST_CHECKED_VALUE as usize, 0);
    let initial_status = format!(
        "Ready. Process name under test: OroNimbus.exe\r\nLauncher {launcher_hardening_status}"
    );
    let status = create_child(
        hwnd,
        instance,
        "STATIC",
        &initial_status,
        WS_CHILD | WS_VISIBLE,
        24,
        388,
        750,
        64,
        0,
    );
    let note = create_child(
        hwnd,
        instance,
        "STATIC",
        "Recovered path: WDA_MONITOR (0x01) + 3-second readback/reapply watchdog.\r\nEXCLUDE (0x11) remains a separate Electron capability test, not a confirmed recovered product call path.",
        WS_CHILD | WS_VISIBLE,
        24,
        474,
        750,
        64,
        0,
    );
    STATUS_HANDLE.store(status as isize, Ordering::Relaxed);

    let font = GetStockObject(DEFAULT_GUI_FONT);
    for control in [
        heading,
        description,
        exclude,
        monitor,
        none,
        folder,
        fullscreen,
        watchdog,
        harden_dll_search,
        module_monitor,
        status,
        note,
    ] {
        if !control.is_null() {
            SendMessageW(control, WM_SETFONT, font as usize, 1);
        }
    }
}

#[allow(clippy::too_many_arguments)]
unsafe fn create_child(
    parent: HWND,
    instance: *mut core::ffi::c_void,
    class_name: &str,
    text: &str,
    style: u32,
    x: i32,
    y: i32,
    width: i32,
    height: i32,
    id: usize,
) -> HWND {
    let class_name = wide(class_name);
    let text = wide(text);
    CreateWindowExW(
        0,
        class_name.as_ptr(),
        text.as_ptr(),
        style,
        x,
        y,
        width,
        height,
        parent,
        id as HMENU,
        instance,
        ptr::null(),
    )
}

fn bundle_root() -> Result<PathBuf, String> {
    std::env::current_exe()
        .map_err(|error| format!("Cannot resolve launcher path: {error}"))?
        .parent()
        .map(PathBuf::from)
        .ok_or_else(|| "Launcher has no parent directory".to_owned())
}

fn browser_path() -> Result<PathBuf, String> {
    let path = bundle_root()?.join("OroNimbus").join("OroNimbus.exe");
    if path.is_file() {
        Ok(path)
    } else {
        Err(format!("OroNimbus.exe was not found at {}", path.display()))
    }
}

fn launch_browser(
    mode: &str,
    fullscreen: bool,
    watchdog: bool,
    harden_dll_search: bool,
    module_monitor: bool,
) -> Result<u32, String> {
    let path = browser_path()?;
    let working_directory = path
        .parent()
        .ok_or_else(|| "Invalid OroNimbus path".to_owned())?;
    let mut command = Command::new(&path);
    command.arg(format!("--wda={mode}"));
    if fullscreen {
        command.arg("--fullscreen");
    }
    if watchdog {
        command.arg("--watchdog");
    }
    if harden_dll_search {
        command.arg("--harden-dll-search");
    }
    if module_monitor {
        command.arg("--module-monitor");
    }
    command
        .current_dir(working_directory)
        .spawn()
        .map(|child| child.id())
        .map_err(|error| format!("Could not launch {}: {error}", path.display()))
}

fn open_scan_target() -> Result<(), String> {
    let folder = bundle_root()?.join("OroNimbus");
    if !folder.is_dir() {
        return Err(format!("Scan target was not found at {}", folder.display()));
    }
    Command::new("explorer.exe")
        .arg(&folder)
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("Could not open scan target: {error}"))
}

unsafe fn report(value: &str) {
    let status = STATUS_HANDLE.load(Ordering::Relaxed) as HWND;
    if !status.is_null() {
        let value = wide(value);
        SetWindowTextW(status, value.as_ptr());
    }
}

unsafe extern "system" fn window_proc(
    hwnd: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    match message {
        WM_COMMAND => {
            let fullscreen_control = GetDlgItem(hwnd, ID_FULLSCREEN as i32);
            let fullscreen = !fullscreen_control.is_null()
                && SendMessageW(fullscreen_control, BM_GETCHECK, 0, 0) as u32 == BST_CHECKED_VALUE;
            let watchdog_control = GetDlgItem(hwnd, ID_WATCHDOG as i32);
            let watchdog = !watchdog_control.is_null()
                && SendMessageW(watchdog_control, BM_GETCHECK, 0, 0) as u32 == BST_CHECKED_VALUE;
            let hardening_control = GetDlgItem(hwnd, ID_HARDEN_DLL_SEARCH as i32);
            let harden_dll_search = !hardening_control.is_null()
                && SendMessageW(hardening_control, BM_GETCHECK, 0, 0) as u32 == BST_CHECKED_VALUE;
            let module_monitor_control = GetDlgItem(hwnd, ID_MODULE_MONITOR as i32);
            let module_monitor = !module_monitor_control.is_null()
                && SendMessageW(module_monitor_control, BM_GETCHECK, 0, 0) as u32
                    == BST_CHECKED_VALUE;
            let display = if fullscreen { "fullscreen" } else { "windowed" };
            let defenses = if watchdog || harden_dll_search || module_monitor {
                format!(
                    " [watchdog: {}; DLL search: {}; module monitor: {}]",
                    if watchdog { "on" } else { "off" },
                    if harden_dll_search {
                        "hardened"
                    } else {
                        "baseline"
                    },
                    if module_monitor { "on" } else { "off" }
                )
            } else {
                " [defense fixtures off]".to_owned()
            };
            let action = match wparam & 0xffff {
                ID_EXCLUDE => launch_browser("exclude", fullscreen, watchdog, harden_dll_search, module_monitor).map(|pid| format!("Launched OroNimbus.exe PID {pid} {display} with requested WDA_EXCLUDEFROMCAPTURE (0x11){defenses}")),
                ID_MONITOR => launch_browser("monitor", fullscreen, watchdog, harden_dll_search, module_monitor).map(|pid| format!("Launched OroNimbus.exe PID {pid} {display} with requested WDA_MONITOR (0x01){defenses}")),
                ID_NONE => launch_browser("none", fullscreen, watchdog, harden_dll_search, module_monitor).map(|pid| format!("Launched OroNimbus.exe PID {pid} {display} with requested WDA_NONE (0x00){defenses}")),
                ID_FOLDER => open_scan_target().map(|_| "Opened the OroNimbus scan-target folder.".to_owned()),
                _ => return 0,
            };
            match action {
                Ok(value) => report(&value),
                Err(error) => report(&format!("Error: {error}")),
            }
            0
        }
        WM_DESTROY => {
            PostQuitMessage(0);
            0
        }
        _ => DefWindowProcW(hwnd, message, wparam, lparam),
    }
}
