import { Routes, Route } from 'react-router-dom'
import { AppShell } from './components/layout/AppShell'
import { ComingSoon } from './components/layout/ComingSoon'

export function App() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<ComingSoon area="Dashboard" />} />
        <Route path="recommendations" element={<ComingSoon area="Recomendações" />} />
        <Route path="recommendations/:id" element={<ComingSoon area="Detalhe" />} />
        <Route path="runs" element={<ComingSoon area="Runs" />} />
        <Route path="runs/:id" element={<ComingSoon area="Run Detail" />} />
        <Route path="campaigns/:accountId/:campaignId" element={<ComingSoon area="Campaign" />} />
        <Route path="skills" element={<ComingSoon area="Skills" />} />
        <Route path="digest" element={<ComingSoon area="Digest" />} />
        <Route path="*" element={<ComingSoon area="404" />} />
      </Route>
    </Routes>
  )
}
