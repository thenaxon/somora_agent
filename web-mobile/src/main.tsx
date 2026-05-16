import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles.css';

const root = document.getElementById('root');
if (!root) {
  throw new Error('somora-mobile: #root not found in index.html');
}

// Register the service-worker so the app shell is cached and the
// "add to home screen" install prompt becomes available. Failures
// are non-fatal — the app works fine without offline caching, the
// user just doesn't get the installable-PWA experience.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('./service-worker.js', { scope: '/mobile/' })
      .catch((err) => {
        console.warn('[somora-mobile] service-worker registration failed:', err);
      });
  });
}

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
