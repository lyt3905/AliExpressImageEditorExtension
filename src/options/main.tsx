import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { OptionsApp } from './App';
import '../editor/styles/index.css';

const container = document.getElementById('options-root');
if (!container) throw new Error('缺少 #options-root 容器');

createRoot(container).render(
  <StrictMode>
    <OptionsApp />
  </StrictMode>,
);
