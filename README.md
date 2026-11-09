# AI is done get back to work — Firefox extension

Alerts you when ChatGPT, Claude, or Gemini completes a response.

Controls:
- **On** — enables or disables completion alerts and completed-tab markings.
- **Volume** — adjusts the ding and spoken announcement volume.

When you are viewing an AI tab, you hear one ding at completion. If you are on another tab, you hear a ding followed by the AI name (if an English system voice is available, otherwise a distinct chime). Background AI tabs are highlighted and marked as ready. Announcement speech uses an automatically chosen installed system voice at normal speed. All audio is local.


1. Download files into one folder
2. Open Firefox `about:debugging#/runtime/this-firefox`
3. Click "Load Temporary Add-on"
4. Select manifest.json
5. Refresh any AI model tabs.


## Included files

- `manifest.json`
- `background.js`, `detector.js`
- `popup.html`, `popup.css`, `popup.js`
- `ding.wav`, `chimes/`, `icons/`
- `README.md`

Further implementation may include buttplug integration if demand is high. 
