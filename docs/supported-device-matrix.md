# Supported Device Matrix

Automated coverage runs on every pull request through Playwright. Record real
device evidence before the season and after material scoring-interface changes.

| Surface | Automated profile | Required manual check | Current evidence |
| --- | --- | --- | --- |
| Desktop Chromium | Desktop Chrome | Keyboard and 200% zoom | Full production-PWA journey passed 2026-08-20; manual check due |
| Desktop Firefox | Desktop Firefox | Keyboard and 200% zoom | Full production-PWA journey passed 2026-08-20; manual check due |
| Desktop Safari engine | Desktop Safari/WebKit | macOS Safari + VoiceOver | WebKit journey passed 2026-08-20; physical offline refresh and accessibility checks due |
| Android | Pixel 7 Chromium | Chrome + TalkBack + sunlight | Full emulated production-PWA journey passed 2026-08-20; physical check due |
| iPhone | WebKit responsive layouts | Mobile Safari + VoiceOver + sunlight | Physical check due |
| Poor connectivity | Production-PWA offline queue/reload/reconnect paths | Real course reconnect/queue drill | Automated queue and exact-once reconnect passed 2026-08-20; field check due |

“Configured” is not a manual pass. Add tester, OS/browser version, date, result,
and issue link to the accessibility record for each physical check. The app
supports current evergreen browsers; embedded in-app browsers are best effort.
