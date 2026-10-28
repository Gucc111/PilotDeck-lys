import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import TeamModeControls from '../../src/components/team-runtime/TeamModeControls';
import TeamTeammateRouteView from '../../src/components/team-runtime/TeamTeammateRouteView';
import { useTeamMode } from '../../src/components/team-runtime/useTeamMode';
import i18n from '../../src/i18n/config';
import { FindShortcutProvider } from '../../src/contexts/FindShortcutContext';
import '../../src/index.css';
const project = { name: 'release', displayName: 'Controlled fixture project', fullPath: '/fixture/project' };
i18n.changeLanguage(localStorage.getItem('userLanguage') || 'en');
function Root() {
  const mode = useTeamMode({ sessionKey: 'web:fixture-root', project, projects: [project], busy: false });
  return <main style={{ maxWidth: 960, margin: '60px auto', padding: 16 }}>
    <p data-testid="fixture-boundary">Controlled browser fixture · mocked API and events · no model or tool execution</p>
    <TeamModeControls mode={mode}/>
    <section data-testid="leader-chat">Leader conversation remains separate.</section>
  </main>;
}
createRoot(document.getElementById('root')).render(<FindShortcutProvider activeScope="chat"><BrowserRouter><Routes>
  <Route path="/team/:rootSessionKey/:activationId/teammate/:participantId" element={<TeamTeammateRouteView/>}/>
  <Route path="*" element={<Root/>}/>
</Routes></BrowserRouter></FindShortcutProvider>);
