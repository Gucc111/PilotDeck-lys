import React, { useState } from 'react';
import QueuedMessagesTray from '../../src/components/chat-v2/QueuedMessagesTray';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import TeamModeControls from '../../src/components/team-runtime/TeamModeControls';
import TeamTeammateRouteView from '../../src/components/team-runtime/TeamTeammateRouteView';
import { useTeamMode } from '../../src/components/team-runtime/useTeamMode';
import SubagentDetailMessageFlow from '../../src/components/chat-v2/SubagentDetailMessageFlow';
import i18n from '../../src/i18n/config';
import { FindShortcutProvider } from '../../src/contexts/FindShortcutContext';
import '../../src/index.css';
const project = { name: 'release', displayName: 'Controlled fixture project', fullPath: '/fixture/project' };
i18n.changeLanguage(localStorage.getItem('userLanguage') || 'en');
function Root() {
  const mode = useTeamMode({ sessionKey: 'web:fixture-root', project, projects: [project], busy: false });
  const [queue, setQueue] = useState({ sessionId: 'web:fixture-root', revision: 1, paused: false, items: [
    { id: 'user-queued', displayText: 'Please preserve the database.', status: 'queued', createdAt: '2026-11-02T00:00:00Z' },
    { id: 'user-invalidated', displayText: 'Expired user request', status: 'invalidated', createdAt: '2026-11-02T00:00:00Z' },
  ] });
  return <main style={{ maxWidth: 960, margin: '60px auto', padding: 16 }}>
    <p data-testid="fixture-boundary">Controlled browser fixture · mocked API and events · no model or tool execution</p>
    <TeamModeControls mode={mode}/>
    <section data-testid="leader-composer">
      <QueuedMessagesTray state={queue} isLoading teamActivation={mode.activation} onDeleteTeamMessage={mode.deleteMessage}
        onResume={() => {}} onMoveToFront={() => {}}
        onSteer={id => setQueue(current => ({ ...current, items: current.items.map(item => item.id === id ? { ...item, status: 'steering' } : item) }))}
        onDelete={id => setQueue(current => ({ ...current, items: current.items.filter(item => item.id !== id) }))}/>
      <textarea aria-label="Leader input" style={{ width: '100%', minHeight: 80 }} />
    </section>
    <section data-testid="leader-chat">Leader conversation remains separate.</section>
    <div style={{ height: 500, display: 'flex', flexDirection: 'column' }} data-testid="leader-turn-view"><SubagentDetailMessageFlow messages={[
      { id: 'human', type: 'user', content: 'Review the release', timestamp: '2026-10-29T09:00:00Z', turnId: 'human-turn' },
      { id: 'first-answer', type: 'assistant', content: 'Initial Leader final answer.', timestamp: '2026-10-29T09:00:01Z', turnId: 'human-turn' },
      { id: 'team:dispatch', type: 'system', content: '', timestamp: '2026-10-29T09:00:02Z', turnId: 'automatic-turn', isTeamBoundary: true, isTeamInjection: true, teamMessageIds: ['notice'] },
      { id: 'continuation', type: 'assistant', content: 'Leader checked the member result.', timestamp: '2026-10-29T09:00:03Z', turnId: 'automatic-turn' },
    ]} provider="pilotdeck" selectedProject={null} createDiff={() => []} isRunning={false}/></div>
  </main>;
}
createRoot(document.getElementById('root')).render(<FindShortcutProvider activeScope="chat"><BrowserRouter><Routes>
  <Route path="/team/:rootSessionKey/:activationId/teammate/:participantId" element={<TeamTeammateRouteView/>}/>
  <Route path="*" element={<Root/>}/>
</Routes></BrowserRouter></FindShortcutProvider>);
