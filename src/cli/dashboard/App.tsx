import React, { useState, useEffect } from 'react';
import { Box, useInput, useApp } from 'ink';
import { AgentMCPConfig } from '../../config/schema.js';
import { SessionManager, AgentSession } from '../../engine/session.js';
import { Header } from './Header.js';
import { Footer } from './Footer.js';
import { SessionsView } from './SessionsView.js';
import { SystemView } from './SystemView.js';
import { ReviewView } from './ReviewView.js';
import { LauncherModal } from './LauncherModal.js';
import { SendInputModal } from './SendInputModal.js';

interface AppProps {
  config: AgentMCPConfig;
  configPath?: string;
}

export const DashboardApp: React.FC<AppProps> = ({ config, configPath }) => {
  const { exit } = useApp();
  const [sessionManager] = useState(() => new SessionManager(config));
  const [sessions, setSessions] = useState<AgentSession[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [activeTab, setActiveTab] = useState<'sessions' | 'launcher' | 'system' | 'reviews'>('sessions');
  const [statusMessage, setStatusMessage] = useState<string | undefined>(undefined);
  const [showSendInputModal, setShowSendInputModal] = useState(false);

  const availableAgents = Object.keys(config.agents);

  // Poll for session state updates
  useEffect(() => {
    const interval = setInterval(() => {
      // Trigger rerender for live event streaming and session status changes
      setSessions((prev) => [...prev]);
    }, 250);
    return () => clearInterval(interval);
  }, []);

  const activeSessionsCount = sessions.filter((s) => s.status === 'running').length;

  useInput((input, key) => {
    if (activeTab === 'launcher' || showSendInputModal) {
      return; // Modal controls keyboard input
    }

    if (input === 'q') {
      exit();
      return;
    }

    if (input === '1') {
      setActiveTab('sessions');
    } else if (input === '2' || input === 'l') {
      setActiveTab('launcher');
    } else if (input === '3') {
      setActiveTab('system');
    } else if (input === '4') {
      setActiveTab('reviews');
    } else if (key.upArrow) {
      setSelectedIndex((prev) => (prev > 0 ? prev - 1 : Math.max(0, sessions.length - 1)));
    } else if (key.downArrow) {
      setSelectedIndex((prev) => (prev < sessions.length - 1 ? prev + 1 : 0));
    } else if (input === 'c') {
      const selected = sessions[selectedIndex];
      if (selected && selected.status === 'running') {
        try {
          sessionManager.cancelSession(selected.id);
          setStatusMessage(`Session ${selected.id.slice(0, 8)} cancelled.`);
        } catch (err) {
          setStatusMessage(`Error cancelling session: ${err}`);
        }
      } else {
        setStatusMessage('No active running session selected to cancel.');
      }
    } else if (input === 's') {
      const selected = sessions[selectedIndex];
      if (selected && selected.status === 'running') {
        setShowSendInputModal(true);
      } else {
        setStatusMessage('Select a running session to send input.');
      }
    }
  });

  const handleLaunch = (agentId: string, prompt: string, workspace: string, kind: 'task' | 'review') => {
    try {
      const session = sessionManager.createSession(agentId, prompt, workspace, undefined, { kind });
      setSessions((prev) => [session, ...prev]);
      setSelectedIndex(0);
      setActiveTab('sessions');
      setStatusMessage(`Launched ${agentId} (${kind}) session ${session.id.slice(0, 8)}`);
    } catch (err) {
      setStatusMessage(`Failed to launch agent: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const handleSendInput = (message: string) => {
    const selected = sessions[selectedIndex];
    if (selected) {
      try {
        sessionManager.sendToSession(selected.id, message);
        setStatusMessage(`Sent input to ${selected.agentId} (${selected.id.slice(0, 8)})`);
      } catch (err) {
        setStatusMessage(`Error sending input: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    setShowSendInputModal(false);
  };

  return (
    <Box flexDirection="column" padding={1} width="100%">
      <Header
        configPath={configPath}
        activeSessions={activeSessionsCount}
        maxSessions={config.security.maxConcurrentSessions}
        activeTab={activeTab}
        sanitizedEnv={config.security.sanitizeEnv !== false}
      />

      {activeTab === 'launcher' ? (
        <LauncherModal
          availableAgents={availableAgents}
          workspaces={config.allowedWorkspaces}
          onLaunch={handleLaunch}
          onCancel={() => setActiveTab('sessions')}
        />
      ) : showSendInputModal && sessions[selectedIndex] ? (
        <SendInputModal
          sessionId={sessions[selectedIndex].id}
          agentName={sessions[selectedIndex].agentConfig.name}
          onSend={handleSendInput}
          onCancel={() => setShowSendInputModal(false)}
        />
      ) : activeTab === 'sessions' ? (
        <SessionsView sessions={sessions} selectedIndex={selectedIndex} />
      ) : activeTab === 'system' ? (
        <SystemView config={config} configPath={configPath} />
      ) : (
        <ReviewView sessions={sessions} />
      )}

      <Footer statusMessage={statusMessage} />
    </Box>
  );
};
