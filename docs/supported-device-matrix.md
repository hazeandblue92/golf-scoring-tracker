# Supported Device Matrix

Automated coverage runs on every pull request through Playwright. Record real
device evidence before the season and after material scoring-interface changes.

| Surface | Automated profile | Required manual check | Current evidence |
| --- | --- | --- | --- |
| Desktop Chromium | Desktop Chrome | Keyboard and 200% zoom | Automation passed 2026-08-10; manual check due |
| Desktop Firefox | Desktop Firefox | Keyboard and 200% zoom | Automation passed 2026-08-10; manual check due |
| Desktop Safari engine | Desktop Safari/WebKit | macOS Safari + VoiceOver | WebKit passed 2026-08-10; physical check due |
| Android | Pixel 7 Chromium | Chrome + TalkBack + sunlight | Emulation passed 2026-08-10; physical check due |
| iPhone | WebKit responsive layouts | Mobile Safari + VoiceOver + sunlight | Physical check due |
| Poor connectivity | Browser/offline test paths | Real course reconnect/queue drill | Field check due |

“Configured” is not a manual pass. Add tester, OS/browser version, date, result,
and issue link to the accessibility record for each physical check. The app
supports current evergreen browsers; embedded in-app browsers are best effort.
