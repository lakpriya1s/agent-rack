import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { resolveSkillsDir, copySkills, handleCpCommand, KNOWN_TARGETS } from './skills.js';

describe('cli/skills', () => {
  let tmpDir: string;
  let mockPackageRoot: string;
  let mockSourceSkillsDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-rack-skills-test-'));
    mockPackageRoot = path.join(tmpDir, 'pkg');
    mockSourceSkillsDir = path.join(mockPackageRoot, 'plugins', 'agent-rack', 'skills');

    // Create mock skills in mock package root
    fs.mkdirSync(path.join(mockSourceSkillsDir, 'tool-selection'), { recursive: true });
    fs.writeFileSync(
      path.join(mockSourceSkillsDir, 'tool-selection', 'SKILL.md'),
      '---\nname: tool-selection\n---'
    );

    fs.mkdirSync(path.join(mockSourceSkillsDir, 'review-handling'), { recursive: true });
    fs.writeFileSync(
      path.join(mockSourceSkillsDir, 'review-handling', 'SKILL.md'),
      '---\nname: review-handling\n---'
    );
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('resolveSkillsDir', () => {
    it('resolves project skills dir for known targets', () => {
      const projectBase = '/test/project';

      expect(resolveSkillsDir({ target: 'claude', scope: 'project', projectBase })).toBe(
        path.join(projectBase, '.claude', 'skills')
      );

      expect(resolveSkillsDir({ target: 'cursor', scope: 'project', projectBase })).toBe(
        path.join(projectBase, '.cursor', 'skills')
      );

      expect(resolveSkillsDir({ target: 'antigravity', scope: 'project', projectBase })).toBe(
        path.join(projectBase, '.gemini', 'skills')
      );

      expect(resolveSkillsDir({ target: 'agy', scope: 'project', projectBase })).toBe(
        path.join(projectBase, '.gemini', 'skills')
      );

      expect(resolveSkillsDir({ target: 'codex', scope: 'project', projectBase })).toBe(
        path.join(projectBase, '.agents', 'skills')
      );

      expect(resolveSkillsDir({ target: 'opencode', scope: 'project', projectBase })).toBe(
        path.join(projectBase, '.opencode', 'skills')
      );
    });

    it('resolves user skills dir for known targets', () => {
      expect(resolveSkillsDir({ target: 'claude', scope: 'user' })).toBe(
        path.join(os.homedir(), '.claude', 'skills')
      );

      expect(resolveSkillsDir({ target: 'cursor', scope: 'user' })).toBe(
        path.join(os.homedir(), '.cursor', 'skills')
      );

      expect(resolveSkillsDir({ target: 'antigravity', scope: 'user' })).toBe(
        path.join(os.homedir(), '.gemini', 'config', 'skills')
      );
    });

    it('throws an error for unknown target', () => {
      expect(() => resolveSkillsDir({ target: 'unknown-target' })).toThrow(
        /Unknown target client 'unknown-target'/
      );
    });

    it('defaults to claude project skills dir when target is omitted', () => {
      const projectBase = '/test/project';
      expect(resolveSkillsDir({ projectBase })).toBe(path.join(projectBase, '.claude', 'skills'));
    });
  });

  describe('copySkills', () => {
    it('copies all skills to destination directory', () => {
      const destDir = path.join(tmpDir, 'dest-skills');
      const copied = copySkills({
        destSkillsDir: destDir,
        packageRootPath: mockPackageRoot,
      });

      expect(copied).toEqual(['agent-rack-review-handling', 'agent-rack-tool-selection']);
      expect(fs.existsSync(path.join(destDir, 'agent-rack-tool-selection', 'SKILL.md'))).toBe(true);
      expect(fs.existsSync(path.join(destDir, 'agent-rack-review-handling', 'SKILL.md'))).toBe(true);
    });

    it('copies a specific skill when skillName option is provided', () => {
      const destDir = path.join(tmpDir, 'dest-skills');
      const copied = copySkills({
        destSkillsDir: destDir,
        skillName: 'tool-selection',
        packageRootPath: mockPackageRoot,
      });

      expect(copied).toEqual(['agent-rack-tool-selection']);
      expect(fs.existsSync(path.join(destDir, 'agent-rack-tool-selection', 'SKILL.md'))).toBe(true);
      expect(fs.existsSync(path.join(destDir, 'agent-rack-review-handling', 'SKILL.md'))).toBe(false);
    });

    it('customizes prefix if requested', () => {
      const destDir = path.join(tmpDir, 'dest-skills');
      const copied = copySkills({
        destSkillsDir: destDir,
        prefix: 'custom-',
        packageRootPath: mockPackageRoot,
      });

      expect(copied).toEqual(['custom-review-handling', 'custom-tool-selection']);
      expect(fs.existsSync(path.join(destDir, 'custom-tool-selection', 'SKILL.md'))).toBe(true);
    });

    it('throws error if skillName does not exist', () => {
      const destDir = path.join(tmpDir, 'dest-skills');
      expect(() =>
        copySkills({
          destSkillsDir: destDir,
          skillName: 'nonexistent-skill',
          packageRootPath: mockPackageRoot,
        })
      ).toThrow(/Skill 'nonexistent-skill' not found/);
    });
  });
});
