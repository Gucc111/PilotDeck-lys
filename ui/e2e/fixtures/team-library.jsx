import React from 'react';
import { createRoot } from 'react-dom/client';
import TeamLibraryPage from '../../src/components/team-library/TeamLibraryPage';
import i18n from '../../src/i18n/config';
import '../../src/index.css';

await i18n.changeLanguage('en');
createRoot(document.getElementById('root')).render(<TeamLibraryPage projects={[{ name: 'work', fullPath: '/work' }]} onCreateProject={() => {}}/>);
