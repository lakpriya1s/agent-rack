import React, { useState, useEffect, useRef } from 'react';
import { Box, Text, useInput, useApp } from 'ink';
import { AgentMCPConfig } from '../../config/schema.js';
import { AgentSessionInfo } from '../../engine/session.js';
import { ParsedAgentEvent } from '../../adapters/base.js';
import { DashboardRemoteClient, type DashboardLaunchMetadata } from './remoteClient.js';
import { Header } from './Header.js';
import { Footer } from './Footer.js';
import { SessionsView } from './SessionsView.js';
import { SystemView } from './SystemView.js';
import { ReviewView } from './ReviewView.js';
import { LauncherModal } from './LauncherModal.js';
import { SendInputModal } from './SendInputModal.js';
import type { DashboardServerMode } from './serverCoordinator.js';
import {
  dashboardExitVerificationFailure,
  decideDashboardExitFromServer,
} from './exitDecision.js';

interface AppProps {
  config: AgentMCPConfig;
  configPath?: string;
  version?: string;
  remoteClient: DashboardRemoteClient;
  serverMode: DashboardServerMode;
  configAuthority: 'local' | 'external';
  launchMetadata: DashboardLaunchMetadata;
  startupMessage?: string;
}

const SESSION_LIST_POLL_MS = 1500;
const SESSION_LOGS_POLL_MS = 750;
const DASHBOARD_REQUEST_TIMEOUT_MS = 3000;

/** Bounds remote MCP operations so a stalled SSE request cannot block dashboard cleanup forever. */
export function withDashboardRequestTimeout<T>(
  request: Promise<T>,
  timeoutMs = DASHBOARD_REQUEST_TIMEOUT_MS
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Dashboard server request timed out after ${timeoutMs}ms.`)),
      timeoutMs
    );
    request.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

export interface DashboardSessionListState {
  sessions: AgentSessionInfo[];
  selectedSessionId?: string;
}

export function refreshSessionList(
  state: DashboardSessionListState,
  sessions: AgentSessionInfo[]
): DashboardSessionListState {
  const selectedSessionId = sessions.some(
    (session) => session.sessionId === state.selectedSessionId
  )
    ? state.selectedSessionId
    : sessions[0]?.sessionId;
  return { sessions, selectedSessionId };
}

export function prependLaunchedSession(
  state: DashboardSessionListState,
  session: AgentSessionInfo
): DashboardSessionListState {
  return {
    sessions: [session, ...state.sessions.filter((item) => item.sessionId !== session.sessionId)],
    selectedSessionId: session.sessionId,
  };
}

export function moveSessionSelection(
  state: DashboardSessionListState,
  direction: -1 | 1
): DashboardSessionListState {
  if (state.sessions.length === 0) return { sessions: [], selectedSessionId: undefined };

  const currentIndex = state.sessions.findIndex(
    (session) => session.sessionId === state.selectedSessionId
  );
  const nextIndex =
    currentIndex < 0
      ? 0
      : (currentIndex + direction + state.sessions.length) % state.sessions.length;
  return { ...state, selectedSessionId: state.sessions[nextIndex].sessionId };
}

export function dashboardConfigAuthorityWarning(
  configAuthority: 'local' | 'external'
): string | undefined {
  if (configAuthority === 'local') return undefined;
  return "EXTERNAL CONFIG — the --connect server's agents, workspaces, and security settings are authoritative; local config values shown here may not apply.";
}

export function shouldRequestDashboardExit(
  input: string,
  ctrl: boolean,
  modalOpen: boolean
): boolean {
  if (input === 'c' && ctrl) return true;
  return input === 'q' && !modalOpen;
}

export const DashboardApp: React.FC<AppProps> = ({
  config,
  configPath,
  version,
  remoteClient,
  serverMode,
  configAuthority,
  launchMetadata,
  startupMessage,
}) => {
  const { exit } = useApp();
  const [sessionListState, setSessionListState] = useState<DashboardSessionListState>({
    sessions: [],
    selectedSessionId: undefined,
  });
  const { sessions, selectedSessionId } = sessionListState;
  const [events, setEvents] = useState<ParsedAgentEvent[]>([]);
  const [activeTab, setActiveTab] = useState<'sessions' | 'launcher' | 'system' | 'reviews'>('sessions');
  const [statusMessage, setStatusMessage] = useState<string | undefined>(startupMessage);
  const [exitArmed, setExitArmed] = useState(false);
  const exitArmedRef = useRef(false);
  const quitInFlight = useRef(false);
  const queuedQuit = useRef(false);
  const exitVerificationFailed = useRef(false);
  const [showSendInputModal, setShowSendInputModal] = useState(false);
  const [connectionLost, setConnectionLost] = useState(false);

  const availableAgents = launchMetadata.agents;
  const availableWorkspaces = launchMetadata.allowedWorkspaces;

  useEffect(() => {
    let cancelled = false;
    let inFlight = false;
    const poll = async () => {
      if (cancelled || inFlight) return;
      inFlight = true;
      try {
        const list = await withDashboardRequestTimeout(remoteClient.listSessions());
        if (!cancelled) {
          setSessionListState((state) => refreshSessionList(state, list));
          setConnectionLost(false);
        }
      } catch {
        if (!cancelled) setConnectionLost(true);
      } finally {
        inFlight = false;
      }
    };
    poll();
    const interval = setInterval(poll, SESSION_LIST_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [remoteClient]);

  useEffect(() => {
    if (!selectedSessionId) {
      setEvents([]);
      return;
    }

    let cancelled = false;
    let inFlight = false;
    setEvents([]);

    const poll = async () => {
      if (cancelled || inFlight) return;

      inFlight = true;
      try {
        const snapshot = await withDashboardRequestTimeout(
          remoteClient.getSessionLogs(selectedSessionId)
        );
        if (!cancelled) setEvents(snapshot);
      } catch {
        // Connection issues are already surfaced by the session-list poll above.
      } finally {
        inFlight = false;
      }
    };
    poll();
    const interval = setInterval(poll, SESSION_LOGS_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [remoteClient, selectedSessionId]);

  const selectedSession =
    sessions.find((session) => session.sessionId === selectedSessionId) ?? sessions[0];
  const selectedIndex = selectedSession
    ? Math.max(
        0,
        sessions.findIndex((session) => session.sessionId === selectedSession.sessionId)
      )
    : 0;

  const activeSessionsCount = sessions.filter((s) => s.status === 'running').length;
  const configAuthorityWarning = dashboardConfigAuthorityWarning(configAuthority);

  const setExitArm = (armed: boolean) => {
    exitArmedRef.current = armed;
    setExitArmed(armed);
  };

  const requestExit = async () => {
    if (quitInFlight.current) {
      // Do not discard an intentional second q/Ctrl+C while the authoritative check is pending.
      queuedQuit.current = true;
      return;
    }
    quitInFlight.current = true;
    try {
      // If the last authoritative check could not reach our owned server, a second deliberate
      // quit must still reach startDashboard's finally block, which closes that server locally.
      if (serverMode === 'auto-started' && exitArmedRef.current && exitVerificationFailed.current) {
        exit();
        return;
      }

      const decision = await decideDashboardExitFromServer(
        serverMode,
        exitArmedRef.current,
        () => withDashboardRequestTimeout(remoteClient.listSessions())
      );
      exitVerificationFailed.current = false;
      if (decision.action === 'exit') {
        exit();
      } else if (decision.action === 'warn') {
        setExitArm(true);
        setStatusMessage(
          `${decision.runningCount} session${decision.runningCount === 1 ? '' : 's'} still running. Press q again to cancel and close the auto-started server.`
        );
      } else {
        await Promise.allSettled(
          decision.sessionIds.map((sessionId) => remoteClient.cancelSession(sessionId))
        );
        exit();
      }
    } catch (error) {
      const failure = dashboardExitVerificationFailure(error);
      exitVerificationFailed.current = true;
      setExitArm(failure.exitArmed);
      setStatusMessage(failure.statusMessage);
    } finally {
      quitInFlight.current = false;
      if (queuedQuit.current) {
        queuedQuit.current = false;
        void requestExit();
      }
    }
  };

  useInput((input, key) => {
    const modalOpen = activeTab === 'launcher' || showSendInputModal;
    if (shouldRequestDashboardExit(input, key.ctrl, modalOpen)) {
      void requestExit();
      return;
    }

    if (modalOpen) {
      return;
    }

    if (exitArmed) {
      exitVerificationFailed.current = false;
      setExitArm(false);
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
      setSessionListState((state) => moveSessionSelection(state, -1));
    } else if (key.downArrow) {
      setSessionListState((state) => moveSessionSelection(state, 1));
    } else if (input === 'c') {
      if (selectedSession && selectedSession.status === 'running') {
        remoteClient
          .cancelSession(selectedSession.sessionId)
          .then(() => setStatusMessage(`Session ${selectedSession.sessionId.slice(0, 8)} cancelled.`))
          .catch((err) =>
            setStatusMessage(`Error cancelling session: ${err instanceof Error ? err.message : String(err)}`)
          );
      } else {
        setStatusMessage('No active running session selected to cancel.');
      }
    } else if (input === 's') {
      if (selectedSession && selectedSession.status === 'running') {
        setShowSendInputModal(true);
      } else {
        setStatusMessage('Select a running session to send input.');
      }
    }
  });

  const handleLaunch = async (
    agentId: string,
    prompt: string,
    workspace: string,
    kind: 'task' | 'review',
    model?: string
  ) => {
    try {
      const session = await remoteClient.createSession(agentId, prompt, workspace, kind, model);
      setSessionListState((state) => prependLaunchedSession(state, session));
      setActiveTab('sessions');
      setStatusMessage(`Launched ${agentId} (${kind}) session ${session.sessionId.slice(0, 8)}`);
    } catch (err) {
      setStatusMessage(`Failed to launch agent: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const handleSendInput = async (message: string) => {
    if (selectedSession) {
      try {
        await remoteClient.sendInput(selectedSession.sessionId, message);
        setStatusMessage(
          `Sent input to ${selectedSession.agentId} (${selectedSession.sessionId.slice(0, 8)})`
        );
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
        version={version}
      />

      {configAuthorityWarning && (
        <Box marginBottom={1} borderStyle="round" borderColor="yellow" paddingX={1}>
          <Text color="yellow" bold>
            {configAuthorityWarning}
          </Text>
        </Box>
      )}

      {connectionLost && (
        <Box marginBottom={1} borderStyle="round" borderColor="red" paddingX={1}>
          <Text color="red" bold>
            ⚠ Connection to agent-rack server lost — retrying…
          </Text>
        </Box>
      )}

      {activeTab === 'launcher' ? (
        <LauncherModal
          availableAgents={availableAgents}
          workspaces={availableWorkspaces}
          onLaunch={handleLaunch}
          onCancel={() => setActiveTab('sessions')}
        />
      ) : showSendInputModal && selectedSession ? (
        <SendInputModal
          sessionId={selectedSession.sessionId}
          agentName={selectedSession.agentName}
          onSend={handleSendInput}
          onCancel={() => setShowSendInputModal(false)}
        />
      ) : activeTab === 'sessions' ? (
        <SessionsView sessions={sessions} selectedIndex={selectedIndex} events={events} />
      ) : activeTab === 'system' ? (
        <SystemView config={config} configPath={configPath} />
      ) : (
        <ReviewView sessions={sessions} />
      )}

      <Footer statusMessage={statusMessage} serverMode={serverMode} />
    </Box>
  );
};
