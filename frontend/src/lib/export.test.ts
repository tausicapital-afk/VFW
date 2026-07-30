import { downloadExport, EXPORT_FORMATS, FORMAT_LABEL } from './export';
import { ApiError } from './api';

function blobResponse(headers: Record<string, string> = {}) {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: new Headers(headers),
    blob: async () => new Blob(['csv,data']),
  } as unknown as Response;
}

describe('EXPORT_FORMATS / FORMAT_LABEL', () => {
  it('has a label entry for every declared format', () => {
    for (const format of EXPORT_FORMATS) {
      expect(FORMAT_LABEL[format]).toBeDefined();
      expect(FORMAT_LABEL[format].label).toBeTruthy();
    }
  });
});

describe('downloadExport', () => {
  let appendedAnchors: HTMLAnchorElement[];

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
    appendedAnchors = [];
    // jsdom doesn't implement real navigation for <a>.click(); stub it so the
    // click just registers, and capture the anchor via appendChild so its
    // href/download attributes can be inspected before downloadExport removes it.
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    const realAppend = document.body.appendChild.bind(document.body);
    vi.spyOn(document.body, 'appendChild').mockImplementation(((node: Node) => {
      if (node instanceof HTMLAnchorElement) appendedAnchors.push(node);
      return realAppend(node);
    }) as typeof document.body.appendChild);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('requests the dataset with the format and the browser timezone as query params', async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(blobResponse());

    await downloadExport('submissions', 'csv');

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/api/export/submissions?');
    expect(url).toContain('format=csv');
    expect(url).toContain('tz=');
    expect(init).toMatchObject({ credentials: 'include' });
  });

  it('names the download from the Content-Disposition header when present', async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(
      blobResponse({ 'Content-Disposition': 'attachment; filename="submissions-2026.csv"' }),
    );

    await downloadExport('submissions', 'csv');

    expect(appendedAnchors).toHaveLength(1);
    expect(appendedAnchors[0].download).toBe('submissions-2026.csv');
    expect(appendedAnchors[0].click).toHaveBeenCalledTimes(1);
  });

  it('falls back to "<dataset>.<format>" when there is no Content-Disposition header', async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(blobResponse());

    await downloadExport('submissions', 'pdf');

    expect(appendedAnchors[0].download).toBe('submissions.pdf');
  });

  it('throws ApiError and never touches the DOM when the request fails', async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 403,
      statusText: 'Forbidden',
      headers: new Headers(),
      json: async () => ({ message: 'You cannot export this dataset' }),
    } as unknown as Response);

    await expect(downloadExport('submissions', 'csv')).rejects.toBeInstanceOf(ApiError);
    expect(appendedAnchors).toHaveLength(0);
  });
});
