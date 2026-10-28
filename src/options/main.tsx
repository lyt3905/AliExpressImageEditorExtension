import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { OptionsApp } from './App';
import '../editor/styles/index.css';
// 设置页自己的样式（`opt-` 前缀）。全局那份只留编辑器与基础元素（按钮、变量），
// 设置页原来寄生在 editor/styles 里的 `.options` 段已经搬到这里。
import './options.css';

const container = document.getElementById('options-root');
if (!container) throw new Error('缺少 #options-root 容器');

createRoot(container).render(
  <StrictMode>
    <OptionsApp />
  </StrictMode>,
);
