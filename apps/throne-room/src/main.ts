import { createApp } from 'vue';
import { initFlags } from '@minions/feature-flags';
import './assets/main.css';
import App from './App.vue';
import { router } from './router';

initFlags(import.meta.env.DEV);

createApp(App).use(router).mount('#app');
