import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { VisitorApp } from './VisitorApp';
import './visitor.css';

const root = document.getElementById('root');
if (!root) throw new Error('Missing root');
createRoot(root).render(
  <StrictMode>
    <VisitorApp />
  </StrictMode>,
);
