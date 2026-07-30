import { api, ApiError } from './api';

function jsonResponse(body: unknown, init: { status?: number } = {}) {
  return {
    ok: (init.status ?? 200) < 400,
    status: init.status ?? 200,
    statusText: 'Status',
    headers: new Headers(),
    json: async () => body,
  } as unknown as Response;
}

describe('api client', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends credentials and a JSON content-type header on every call', async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }));

    await api.get('/api/ping');

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/ping',
      expect.objectContaining({
        credentials: 'include',
        headers: expect.objectContaining({ 'Content-Type': 'application/json' }),
      }),
    );
  });

  it('GET issues a plain request with no method override and no body', async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(jsonResponse({ hello: 'world' }));

    const result = await api.get<{ hello: string }>('/api/thing');

    expect(result).toEqual({ hello: 'world' });
    const [, init] = fetchMock.mock.calls[0];
    expect(init.method).toBeUndefined();
    expect(init.body).toBeUndefined();
  });

  it('POST serializes the body as JSON and defaults to {} when omitted', async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(jsonResponse({ created: true }));

    await api.post('/api/things');

    const [, init] = fetchMock.mock.calls[0];
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{}');
  });

  it('POST forwards a given body, JSON-encoded', async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(jsonResponse({ created: true }));

    await api.post('/api/things', { name: 'Kelso Blue' });

    const [, init] = fetchMock.mock.calls[0];
    expect(init.body).toBe(JSON.stringify({ name: 'Kelso Blue' }));
  });

  it('PATCH and PUT and DELETE set the matching HTTP method', async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue(jsonResponse({}));

    await api.patch('/api/x', { a: 1 });
    await api.put('/api/x', { a: 1 });
    await api.del('/api/x');

    expect(fetchMock.mock.calls[0][1].method).toBe('PATCH');
    expect(fetchMock.mock.calls[1][1].method).toBe('PUT');
    expect(fetchMock.mock.calls[2][1].method).toBe('DELETE');
  });

  it('returns undefined for a 204 No Content instead of parsing a body', async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(jsonResponse(null, { status: 204 }));

    const result = await api.del('/api/x');

    expect(result).toBeUndefined();
  });

  it('throws ApiError with the status and message from a failed response', async () => {
    expect.assertions(3);
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(jsonResponse({ message: 'Not authorized' }, { status: 403 }));

    try {
      await api.get('/api/secret');
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      expect((e as ApiError).status).toBe(403);
      expect((e as ApiError).message).toBe('Not authorized');
    }
  });

  it('joins a Nest validation array of messages into one string', async () => {
    expect.assertions(3);
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ message: ['email must be an email', 'password is too short'] }, { status: 400 }),
    );

    try {
      await api.post('/api/auth/login', {});
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      expect((e as ApiError).message).toBe('email must be an email. password is too short');
      expect((e as ApiError).status).toBe(400);
    }
  });

  it('falls back to statusText when the error body has no message (or is not JSON)', async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      json: async () => { throw new SyntaxError('not json'); },
    } as unknown as Response);

    await expect(api.get('/api/broken')).rejects.toThrow('Internal Server Error');
  });
});
