import { createApp } from 'vue'
import App from './App.vue'
import { router } from './router'
import { applySavedLayout } from './layout'
import './assets/main.css'

applySavedLayout()

createApp(App).use(router).mount('#app')
