import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { bridge } from './bridge';
import './i18n';
import './index.css';

// 浏览器开发模式下添加背景
if (!bridge.isElectron) document.body.classList.add('browser-mode');

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
