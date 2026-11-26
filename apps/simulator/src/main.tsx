import { createRoot } from 'react-dom/client';
import { App } from './simulator/App';
import './simulator/styles.css';

// 不使用 StrictMode：避免开发模式下重复挂载导致实例被创建两次
const root = createRoot(document.getElementById('root')!);
root.render(<App />);

// HMR：先销毁旧实例（卸载触发 dispose），不保留半局状态
import.meta.hot?.dispose(() => root.unmount());
