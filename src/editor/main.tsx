import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles/index.css';

const container = document.getElementById('editor-root');
if (!container) throw new Error('缺少 #editor-root 容器');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
