# D chart

A browser-based assistant that sends chat prompts to an Ollama model running on this computer. It uses no paid AI API or API key. Conversations are saved in this browser's local storage and are not sent to a cloud service.

## Start it

1. Install Ollama for your operating system from [ollama.com/download](https://ollama.com/download).
2. Open a terminal and download a starter model: `ollama pull qwen2.5:3b`.
3. Start Ollama if it did not start automatically (`ollama serve`). Keep it running.
4. Open a terminal in this folder and run `npm start`.
5. Open `http://127.0.0.1:4174` in your browser.

The page will show whether Ollama is available and which local models it found. The model dropdown lets you choose among models installed on this computer. To add one, run `ollama pull <model-name>` and reload the page.

## Limits and privacy

Inference happens on this computer. There are no API credits or usage fees, but responses use your CPU/GPU, memory, electricity, and disk space. Model downloads can be several gigabytes. Speed and answer quality depend on your computer and the model; it cannot promise ChatGPT-level performance or literally unlimited context. The model has built-in safety guidance; this project does not try to remove safeguards.

The server binds only to `127.0.0.1`, so the chat endpoint is not exposed to your network. Chat history is stored in browser local storage; use **Clear saved chats** to remove it. Avoid entering sensitive information on a shared computer.

## Tests

Run `npm test`. The tests use a local mock Ollama endpoint and do not download a model or call a paid AI service.
