import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
    plugins: [react()],
    // Project-site GitHub Pages URL is https://<user>.github.io/AKSODEXPIViewer/,
    // so built asset URLs must be prefixed with the repo name (not "/").
    base: '/AKSODEXPIViewer/',
})
