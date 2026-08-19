import { createRouter, createWebHistory } from 'vue-router';

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', component: () => import('./components/LairOverview.vue') },
    { path: '/wings/:wingName', component: () => import('./components/LairOverview.vue') },
    { path: '/plan', component: () => import('./components/LivingCosmos.vue') },
    { path: '/gsd', component: () => import('./components/GsdOracle.vue') },
    { path: '/flow', component: () => import('./components/SystemFlow.vue') },
    { path: '/movement', component: () => import('./components/MovementView.vue') },
    { path: '/design', component: () => import('./design-exploration/DesignExploration.vue') },
    { path: '/docs', component: () => import('./components/docs/DocsViewer.vue') },
  ],
});
