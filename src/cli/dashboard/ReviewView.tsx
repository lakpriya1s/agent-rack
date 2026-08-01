import React from 'react';
import { Box, Text } from 'ink';
import { AgentSessionInfo } from '../../engine/session.js';

interface ReviewViewProps {
  sessions: AgentSessionInfo[];
}

export const ReviewView: React.FC<ReviewViewProps> = ({ sessions }) => {
  const reviewSessions = sessions.filter((s) => s.kind === 'review' || s.review);

  if (reviewSessions.length === 0) {
    return (
      <Box flexDirection="column" borderStyle="single" borderColor="magenta" padding={2} alignItems="center" justifyContent="center" flexGrow={1}>
        <Text bold color="magenta">
          🔍 No Code Reviews Generated Yet
        </Text>
        <Text color="gray">
          To launch a code review, press <Text bold color="cyan">[l]</Text> and select <Text bold color="magenta">[Code Review]</Text> session kind.
        </Text>
      </Box>
    );
  }

  const latestReview = reviewSessions[reviewSessions.length - 1];
  const review = latestReview.review;

  return (
    <Box flexDirection="column" gap={1} flexGrow={1}>
      <Box borderStyle="single" borderColor="magenta" paddingX={1} justifyContent="space-between">
        <Text bold color="magenta">
          🔍 CODE REVIEW INSPECTOR (Session: {latestReview.sessionId.slice(0, 8)})
        </Text>
        <Text bold color={review?.verdict === 'approve' ? 'green' : 'red'}>
          VERDICT: {review?.verdict === 'approve' ? '✓ APPROVED' : '⚠️ NEEDS ATTENTION'}
        </Text>
      </Box>

      {review?.summary && (
        <Box borderStyle="single" borderColor="gray" paddingX={1} flexDirection="column">
          <Text bold color="white">Executive Summary:</Text>
          <Text color="gray">{review.summary}</Text>
        </Box>
      )}

      <Box flexDirection="column" borderStyle="single" borderColor="cyan" paddingX={1} flexGrow={1}>
        <Text bold color="cyan" underline>
          Findings ({review?.findings?.length || 0})
        </Text>
        {(!review?.findings || review.findings.length === 0) ? (
          <Text color="green">✓ No critical findings or issues reported by reviewer agent.</Text>
        ) : (
          review.findings.map((f, idx) => {
            let sevColor = 'gray';
            if (f.severity === 'critical') sevColor = 'red';
            else if (f.severity === 'high') sevColor = 'yellow';
            else if (f.severity === 'medium') sevColor = 'magenta';

            return (
              <Box key={idx} flexDirection="column" marginY={1}>
                <Box justifyContent="space-between">
                  <Text bold color={sevColor as any}>
                    [{f.severity.toUpperCase()}] {f.title}
                  </Text>
                  <Text color="gray">
                    {f.file}:{f.line_start}-{f.line_end}
                  </Text>
                </Box>
                <Box paddingLeft={2}>
                  <Text color="white">
                    {f.body}
                  </Text>
                </Box>
                {f.recommendation && (
                  <Box paddingLeft={2}>
                    <Text color="green">
                      💡 Rec: {f.recommendation}
                    </Text>
                  </Box>
                )}
              </Box>
            );
          })
        )}
      </Box>

      {review?.next_steps && review.next_steps.length > 0 && (
        <Box borderStyle="single" borderColor="yellow" paddingX={1} flexDirection="column">
          <Text bold color="yellow">Recommended Next Steps:</Text>
          {review.next_steps.map((step, i) => (
            <Text key={i} color="gray">
              • {step}
            </Text>
          ))}
        </Box>
      )}
    </Box>
  );
};
