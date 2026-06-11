import { Routes, Route } from 'react-router-dom'
import { AppShell } from './components/layout/AppShell'
import { ComingSoon } from './components/layout/ComingSoon'
import Dashboard from './pages/Dashboard'
import Recommendations from './pages/Recommendations'
import RecommendationDetail from './pages/RecommendationDetail'
import Runs from './pages/Runs'
import RunDetail from './pages/RunDetail'
import Campaign from './pages/Campaign'
import Skills from './pages/Skills'
import Digest from './pages/Digest'
import OauthCallback from './pages/OauthCallback'

export function App() {
  return (
    <Routes>
      {/* Standalone OAuth callback — no AppShell. Declared FIRST so it wins
          over the AppShell catch-all (`*`). The browser hits this path
          because Godeploy's SPA fallback intercepts Accept: text/html on
          /api/auth/callback and serves the shell. */}
      <Route path="/api/auth/callback" element={<OauthCallback />} />

      <Route element={<AppShell />}>
        <Route index element={<Dashboard />} />
        <Route path="recommendations" element={<Recommendations />} />
        <Route path="recommendations/:id" element={<RecommendationDetail />} />
        <Route path="runs" element={<Runs />} />
        <Route path="runs/:id" element={<RunDetail />} />
        <Route path="campaigns/:accountId/:campaignId" element={<Campaign />} />
        <Route path="skills" element={<Skills />} />
        <Route path="digest" element={<Digest />} />
        <Route path="*" element={<ComingSoon area="404" />} />
      </Route>
    </Routes>
  )
}
