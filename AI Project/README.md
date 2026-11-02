# D chart and Artifi

A browser-based assistant that sends chat prompts to an Ollama model running on this computer. It uses no paid AI API or API key. Conversations are saved in this browser's local storage and are not sent to a cloud service.

`artifi.html` is the Artifi multimodal assistant page. The repository's GitHub Pages workflow publishes it as the project homepage. Its Gemini chat requires your own Google Gemini API key, which is stored in this browser's local storage and sent directly to Google. Browser storage is not encrypted; do not use a shared device or commit an API key. Voice and camera features depend on browser support and permissions.

## Start it

1. Install Ollama for your operating system from [ollama.com/download](https://ollama.com/download).
2. Open a terminal and download a starter model: `ollama pull qwen2.5:3b`.
3. Start Ollama if it did not start automatically (`ollama serve`). Keep it running.
4. Open a terminal in this folder and run `npm start`.
5. Open `http://127.0.0.1:4174` in your browser.
6. To use Artifi locally, open `http://127.0.0.1:4174/artifi.html`.

The D chart page shows whether Ollama is available and which local models it found. The model dropdown lets you choose among models installed on this computer. To add one, run `ollama pull <model-name>` and reload the page.

## Limits and privacy

Inference happens on this computer. There are no API credits or usage fees, but responses use your CPU/GPU, memory, electricity, and disk space. Model downloads can be several gigabytes. Speed and answer quality depend on your computer and the model; it cannot promise ChatGPT-level performance or literally unlimited context. The model has built-in safety guidance; this project does not try to remove safeguards.

The server binds only to `127.0.0.1`, so the chat endpoint is not exposed to your network. Chat history is stored in browser local storage; use **Clear saved chats** to remove it. Avoid entering sensitive information on a shared computer.

## Tests

Run `npm test`. The tests use a local mock Ollama endpoint and do not download a model or call a paid AI service.
