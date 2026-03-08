import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';

import App from './App';

const globalStyles = `
  :root {
    color-scheme: dark;
    --bg: #07131a;
    --panel: rgba(9, 28, 35, 0.82);
    --panel-strong: rgba(11, 36, 45, 0.96);
    --panel-soft: rgba(17, 52, 65, 0.66);
    --text: #f4fbfb;
    --muted: #8fb0ba;
    --line: rgba(149, 212, 219, 0.16);
    --accent: #29d6b3;
    --accent-warm: #ff8a54;
    --danger: #ff4a6a;
    --shadow: 0 22px 65px rgba(0, 0, 0, 0.38);
    font-family: "Avenir Next", "Segoe UI", sans-serif;
  }

  * {
    box-sizing: border-box;
  }

  html, body, #root {
    margin: 0;
    min-height: 100%;
    background:
      radial-gradient(circle at top left, rgba(40, 214, 179, 0.18), transparent 32%),
      radial-gradient(circle at top right, rgba(255, 138, 84, 0.15), transparent 28%),
      linear-gradient(180deg, #061017 0%, #081a24 42%, #06131b 100%);
    color: var(--text);
  }

  body {
    min-height: 100vh;
  }

  button, input, textarea {
    font: inherit;
  }

  a {
    color: inherit;
  }

  ::selection {
    background: rgba(41, 214, 179, 0.28);
  }
`;

if (!document.getElementById('dialectic-global-styles')) {
  const styleElement = document.createElement('style');
  styleElement.id = 'dialectic-global-styles';
  styleElement.textContent = globalStyles;
  document.head.appendChild(styleElement);
}

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>,
);
