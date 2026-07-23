// desktop/windows-chrome.ts — hide the stray console window and the blank phantom
// native window that the Windows `deno desktop --backend raw` build allocates but
// never paints (the app takes the system-browser path there, so it owns no window
// of its own; the console is allocated because the build links as a console
// subsystem executable). Best-effort, Windows-only, and INERT on every other
// platform and under Node/vitest — there are NO top-level Deno references, so
// importing this module is always safe; only the Windows branch touches FFI.
//
// FFI is already granted by the desktop build's `--allow-ffi`. `ShowWindow(SW_HIDE)`
// is preferred over `FreeConsole` so stdout stays valid — the boot path logs.

export function hideWindowsStartupChrome(): void {
  // Guard first: a no-op off Windows, and under Node/vitest where `Deno` is
  // undefined (the platform-guard test stubs `Deno.build.os` for other OSes).
  if (typeof Deno === 'undefined' || Deno.build.os !== 'windows') return;
  const SW_HIDE = 0;
  try {
    const kernel32 = Deno.dlopen('kernel32.dll', {
      GetConsoleWindow: { parameters: [], result: 'pointer' },
      GetCurrentProcessId: { parameters: [], result: 'u32' },
    });
    const user32 = Deno.dlopen('user32.dll', {
      ShowWindow: { parameters: ['pointer', 'i32'], result: 'i32' },
      EnumWindows: { parameters: ['function', 'isize'], result: 'i32' },
      GetWindowThreadProcessId: { parameters: ['pointer', 'buffer'], result: 'u32' },
    });

    // Hide the console window that owns the process.
    const consoleWnd = kernel32.symbols.GetConsoleWindow();
    if (consoleWnd) user32.symbols.ShowWindow(consoleWnd, SW_HIDE);

    // Hide any top-level window this process owns — the raw backend's default,
    // never-painted "Lattice" window. Match by owning process id.
    const myPid = kernel32.symbols.GetCurrentProcessId();
    const pidBuf = new Uint32Array(1);
    const cb = new Deno.UnsafeCallback(
      { parameters: ['pointer', 'isize'], result: 'i32' },
      (hwnd: Deno.PointerValue) => {
        user32.symbols.GetWindowThreadProcessId(hwnd, pidBuf);
        if (pidBuf[0] === myPid) user32.symbols.ShowWindow(hwnd, SW_HIDE);
        return 1; // keep enumerating
      },
    );
    user32.symbols.EnumWindows(cb.pointer, 0n);
    cb.close();
  } catch (e) {
    // Best-effort — the browser tab is the real UI. Log once and carry on.
    console.error('[desktop] could not hide Windows startup chrome:', (e as Error).message);
  }
}
