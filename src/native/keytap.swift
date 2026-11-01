// Watches the keyboard for a double tap of the left Control key and prints "double-ctrl"
// on stdout, so Blu can start listening without a multi-key shortcut (Electron's own
// shortcuts can't see a modifier pressed on its own). Needs Input Monitoring permission;
// macOS asks the first time. Exits when its parent closes stdin.

import CoreGraphics
import Foundation

// macOS grants Input Monitoring to the "responsible" app at the top of the launch chain
// (Terminal, an IDE, whatever started Blu), not to us. Re-exec once with responsibility
// disclaimed so the permission belongs to this helper ("keytap") however Blu is launched.
// Same private API Chromium uses for its helpers.
@_silgen_name("responsibility_spawnattrs_setdisclaim")
func responsibility_spawnattrs_setdisclaim(_ attrs: UnsafeMutablePointer<posix_spawnattr_t?>, _ disclaim: Int32) -> Int32

if getenv("KEYTAP_DISCLAIMED") == nil, let exe = Bundle.main.executablePath {
    setenv("KEYTAP_DISCLAIMED", "1", 1)
    var attr: posix_spawnattr_t?
    posix_spawnattr_init(&attr)
    _ = responsibility_spawnattrs_setdisclaim(&attr, 1)
    posix_spawnattr_setflags(&attr, Int16(POSIX_SPAWN_SETEXEC)) // replace this process: same pid and pipes
    let argv: [UnsafeMutablePointer<CChar>?] = CommandLine.arguments.map { strdup($0) } + [nil]
    posix_spawn(nil, exe, nil, &attr, argv, environ)
    // only reached if the re-exec failed; carry on as we are
}

setvbuf(stdout, nil, _IOLBF, 0)

let leftControl: Int64 = 59
let tapMax = 0.3 // a tap is a press shorter than this...
let gapMax = 0.45 // ...and two taps closer together than this are a double tap

var isDown = false
var downAt = 0.0
var usedAsModifier = false // Ctrl+C and friends must not count as taps
var lastTap = -1.0
var tap: CFMachPort?

func now() -> Double { ProcessInfo.processInfo.systemUptime }

let callback: CGEventTapCallBack = { _, type, event, _ in
    switch type {
    case .tapDisabledByTimeout, .tapDisabledByUserInput:
        if let tap { CGEvent.tapEnable(tap: tap, enable: true) }
    case .flagsChanged:
        guard event.getIntegerValueField(.keyboardEventKeycode) == leftControl else {
            lastTap = -1
            if isDown { usedAsModifier = true }
            break
        }
        let pressed = event.flags.contains(.maskControl)
        if pressed && !isDown {
            isDown = true
            downAt = now()
            usedAsModifier = false
        } else if !pressed && isDown {
            isDown = false
            let t = now()
            if !usedAsModifier && t - downAt < tapMax {
                if lastTap > 0 && t - lastTap < gapMax {
                    print("double-ctrl")
                    lastTap = -1
                } else {
                    lastTap = t
                }
            } else {
                lastTap = -1
            }
        }
    case .keyDown, .leftMouseDown, .rightMouseDown:
        lastTap = -1
        if isDown { usedAsModifier = true }
    default:
        break
    }
    return Unmanaged.passUnretained(event)
}

func startTap() -> Bool {
    let types: [CGEventType] = [.flagsChanged, .keyDown, .leftMouseDown, .rightMouseDown]
    let mask = types.reduce(CGEventMask(0)) { $0 | (1 << CGEventMask($1.rawValue)) }
    guard let t = CGEvent.tapCreate(tap: .cgSessionEventTap, place: .headInsertEventTap, options: .listenOnly,
                                    eventsOfInterest: mask, callback: callback, userInfo: nil) else { return false }
    tap = t
    CFRunLoopAddSource(CFRunLoopGetCurrent(), CFMachPortCreateRunLoopSource(nil, t, 0), .commonModes)
    CGEvent.tapEnable(tap: t, enable: true)
    return true
}

// Without Input Monitoring a tap can still be created but never sees a key, so wait for
// the permission itself; the user may grant it in System Settings while we run.
if CGPreflightListenEventAccess() && startTap() {
    print("ready")
} else {
    print("need-permission")
    _ = CGRequestListenEventAccess()
    Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { timer in
        if CGPreflightListenEventAccess() && startTap() {
            print("ready")
            timer.invalidate()
        }
    }
}

FileHandle.standardInput.readabilityHandler = { handle in
    if handle.availableData.isEmpty { exit(0) }
}
CFRunLoopRun()
