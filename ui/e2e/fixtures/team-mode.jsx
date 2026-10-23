import React, { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import Composer from '../../src/components/chat-v2/ComposerV2';
import TeamModeControls from '../../src/components/team-runtime/TeamModeControls';
import { useTeamMode } from '../../src/components/team-runtime/useTeamMode';
import i18n from '../../src/i18n/config';
import '../../src/index.css';
i18n.changeLanguage('en');
const noop = () => {};
const project = { name: 'general', kind: 'general', fullPath: '/general' };
const projects = [project, { name: 'work', displayName: 'Release project', fullPath: '/work' }];
const props = {
  placeholder: 'Message', renderInputWithMentions: text => text,
  onTextareaClick: noop, onTextareaKeyDown: noop, onTextareaPaste: noop, onTextareaScrollSync: noop, onTextareaInput: noop,
  openImagePicker: noop, onAddAttachmentFiles: noop, attachedImages: [], onRemoveImage: noop, onRetryImage: noop,
  documentReferences: [], onRemoveDocumentReference: noop, uploadingImages: new Map(), imageErrors: new Map(),
  filteredFiles: [], selectedFileMentions: [], selectedSkills: [], selectedCommands: [], filteredCommands: [], frequentCommands: [],
  getRootProps: () => ({}), getInputProps: () => ({}), pendingPermissionRequests: [], permissionMode: 'default', runMode: 'agent',
  onPermissionModeChange: noop, onRunModeChange: noop, onInsertSlash: noop, onToggleCommandMenu: noop,
};
function App() {
  const query = new URLSearchParams(location.search);
  const sessionKey = query.get('session');
  const [input, setInput] = useState('Review this release');
  const mode = useTeamMode({ sessionKey, project, projects, busy: false });
  const textareaRef = useRef(null), highlightRef = useRef(null);
  return <main style={{ maxWidth: 860, margin: '120px auto', padding: 12 }}>
    <div data-testid="chat-history">Existing conversation history stays here.</div>
    <output data-testid="activation">{mode.teamActivationId || ''}</output>
    <TeamModeControls mode={mode}/>
    <Composer {...props} input={input} projectKey="/general" textareaRef={textareaRef} inputHighlightRef={highlightRef}
      onInputChange={event => setInput(event.target.value)} onSubmit={event => event.preventDefault()}
      modelCatalog={[]} modelSelection={null} isModelSelectionReady={mode.ready && Boolean(mode.selectedTeam)}
      teamCatalog={mode.teams} selectedTeam={mode.selectedTeam} isTeamCatalogLoading={mode.catalogLoading}
      teamCatalogError={mode.catalogError} executionSelectionLocked={mode.locked} onTeamSelectionChange={mode.selectTeam}
      onRefreshTeams={mode.reloadCatalog} onModelSelectionChange={mode.selectSolo}
      isLoading={mode.working} canAbortSession={mode.working} onAbortSession={() => void mode.stop()}/>
  </main>;
}
createRoot(document.getElementById('root')).render(<App/>);
