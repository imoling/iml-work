import React from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'
import Layout from './components/Layout.jsx'
import Home from './pages/Home.jsx'
import Projects from './pages/Projects.jsx'
import ProjectDetail from './pages/ProjectDetail.jsx'
import Scenarios from './pages/Scenarios.jsx'
import ScenarioWorkspace from './pages/ScenarioWorkspace.jsx'
import Templates from './pages/Templates.jsx'
import Connections from './pages/Connections.jsx'
import QuickSkill from './pages/QuickSkill.jsx'

export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/" element={<Home />} />
        <Route path="/projects" element={<Projects />} />
        <Route path="/projects/:id" element={<ProjectDetail />} />
        <Route path="/scenarios" element={<Scenarios />} />
        <Route path="/scenarios/:id" element={<ScenarioWorkspace />} />
        <Route path="/scenarios/:id/:stage" element={<ScenarioWorkspace />} />
        <Route path="/connections" element={<Connections />} />
        <Route path="/quick" element={<QuickSkill />} />
        <Route path="/templates" element={<Templates />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  )
}
