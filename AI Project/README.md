# Artifi

Artifi is a Google Gemini 3.6 Flash browser assistant with voice input/output, camera hand gestures, and OCR question scanning. Chat prompts go directly from your browser to Google's Gemini API; the app does not run its own AI backend. Conversations and your API key are saved in this browser's local storage.

Voice and camera features require browser support and permission. Camera frames are processed in the browser; OCR and hand-tracking code is downloaded from public CDNs when used. Only OCR-recognized question text is sent to Gemini. Browser local storage is not encrypted, so use your own trusted device.

## Start it

1. Install Node.js 20.19 or newer.
2. Open a terminal in this folder and run `npm start`.
3. Open `http://127.0.0.1:4174` in your browser.
4. Choose **Add API key** and enter a key created in [Google AI Studio](https://aistudio.google.com/app/apikey). Artifi uses the stable `gemini-3.6-flash` model.

Use **Voice** to ask by speech, **HUD** to enable the camera and hand gestures, and **Scan question** to read text from the camera and ask Artifi. Camera access requires HTTPS or localhost.

## Limits and privacy

Gemini use is subject to Google's account, rate, and billing terms. Exact-answer instructions cannot guarantee a model will always be correct. Never publish or commit an API key; the browser key field is intended for your own device, and a key stored in browser storage can be accessed by anyone using that browser profile.

Chat history is stored in browser local storage; use **Clear saved chats** to remove it. Use **Clear key** to remove the saved API key. Camera frames are not stored or uploaded by Artifi; OCR engine files are downloaded from public CDNs.

## Tests

Run `npm test`. The tests use a local mock for the legacy local-model route and never call Google or use a real API key.
