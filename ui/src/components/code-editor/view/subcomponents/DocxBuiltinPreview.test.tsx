// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import DocxBuiltinPreview from './DocxBuiltinPreview';

const renderAsyncMock = vi.hoisted(() => vi.fn(async (
  _blob: Blob,
  bodyContainer: HTMLElement,
) => {
  const wrapper = document.createElement('div');
  wrapper.className = 'pilotdeck-docx-wrapper';
  for (let index = 0; index < 4; index += 1) {
    const section = document.createElement('section');
    section.className = 'pilotdeck-docx';
    section.textContent = `Document section ${index + 1}`;
    wrapper.append(section);
  }
  bodyContainer.append(wrapper);
}));

vi.mock('docx-preview', () => ({
  renderAsync: renderAsyncMock,
}));

afterEach(() => {
  cleanup();
  renderAsyncMock.mockClear();
});

describe('DocxBuiltinPreview', () => {
  it('does not expose rendered sections as Word page controls', async () => {
    render(
      <DocxBuiltinPreview
        blob={new Blob(['docx-data'])}
        fileName="report.docx"
        filePath="report.docx"
        onError={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId('docx-builtin-preview').textContent).toContain('Document section 4');
    });

    expect(screen.queryByLabelText('builtinOfficePreview.previousItem')).toBeNull();
    expect(screen.queryByLabelText('builtinOfficePreview.nextItem')).toBeNull();
    expect(screen.queryByText('1 / 4')).toBeNull();
  });

  it('does not rebuild the document when callback props change', async () => {
    const blob = new Blob(['docx-data']);
    const props = {
      blob,
      fileName: 'report.docx',
      filePath: 'report.docx',
      onError: vi.fn(),
    };
    const { rerender } = render(<DocxBuiltinPreview {...props} />);

    await waitFor(() => {
      expect(renderAsyncMock).toHaveBeenCalledTimes(1);
    });

    rerender(<DocxBuiltinPreview {...props} onError={vi.fn()} />);

    await Promise.resolve();
    expect(renderAsyncMock).toHaveBeenCalledTimes(1);
  });
});
