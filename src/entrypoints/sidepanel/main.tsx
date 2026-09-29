import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { applyAppearance, type Appearance } from '@/shared/appearance';
import { loadAppearance, onAppearanceChanged } from '@/shared/appearance-store';
import '@/shared/theme/tokens.css';
import './panel.css';

// The look is the two attributes on <html> the tokens key on, set before the
// first render so the panel never flashes the default — and kept in step with
// storage, which is where the 外观 section writes and nothing else is told.
let unfollow = () => {};
const follow = (a: Appearance) => {
  unfollow();
  unfollow = applyAppearance(document.documentElement, a);
};

void loadAppearance().then((a) => {
  follow(a);
  onAppearanceChanged(follow);
  createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
});
