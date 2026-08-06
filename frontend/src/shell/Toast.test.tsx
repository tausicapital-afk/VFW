import { act, fireEvent, render, screen } from '@testing-library/react';
import { ToastProvider, useToast } from './Toast';

// These tests drive the dismiss timers directly, so they use fireEvent rather
// than userEvent — userEvent runs its own clock and deadlocks against fake ones.

const onUndo = vi.fn();

/** A bare consumer that exposes each shorthand as a button. */
function Harness() {
  const { showSuccess, showError, showInfo, showToast, hideAll } = useToast();
  return (
    <div>
      <button onClick={() => showSuccess('Submission saved')}>ok</button>
      <button onClick={() => showError('Could not reach the server')}>fail</button>
      <button onClick={() => showInfo('Syncing')}>info</button>
      <button onClick={() => showToast({ message: 'Custom', title: 'Exported', type: 'success' })}>
        custom
      </button>
      <button
        onClick={() =>
          showToast({ message: 'Deleted', type: 'warning', action: { label: 'Undo', onClick: onUndo } })
        }
      >
        undoable
      </button>
      <button onClick={hideAll}>clear</button>
    </div>
  );
}

function renderHarness() {
  return render(
    <ToastProvider>
      <Harness />
    </ToastProvider>,
  );
}

const click = (label: string) => fireEvent.click(screen.getByText(label));
const clickByName = (name: string) => fireEvent.click(screen.getByRole('button', { name }));
const tick = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });

describe('<ToastProvider />', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    onUndo.mockClear();
  });

  afterEach(() => {
    // Draining these fires the mount/dismiss timers, which set state.
    act(() => { vi.runOnlyPendingTimers(); });
    vi.useRealTimers();
  });

  it("shows a success toast with the type's default title", () => {
    renderHarness();
    click('ok');

    expect(screen.getByText('Submission saved')).toBeInTheDocument();
    expect(screen.getByText('Done')).toBeInTheDocument();
  });

  it('gives an error toast role="alert" so it is announced immediately', () => {
    renderHarness();
    click('fail');

    expect(screen.getByRole('alert')).toHaveTextContent('Could not reach the server');
  });

  it('takes an explicit title over the default', () => {
    renderHarness();
    click('custom');

    expect(screen.getByText('Exported')).toBeInTheDocument();
    expect(screen.queryByText('Done')).not.toBeInTheDocument();
  });

  it('dismisses itself once the duration plus the exit animation elapses', () => {
    renderHarness();
    click('info');
    expect(screen.getByText('Syncing')).toBeInTheDocument();

    // The card arms its dismiss timer from the slide-in effect, so let that
    // land before counting down — otherwise the clock starts at the wrong zero.
    tick(20);

    // Still on screen a moment before the 5s default expires.
    tick(4900);
    expect(screen.getByText('Syncing')).toBeInTheDocument();

    tick(500);
    expect(screen.queryByText('Syncing')).not.toBeInTheDocument();
  });

  it('keeps an error on screen longer than the default', () => {
    renderHarness();
    click('fail');
    tick(20); // let the slide-in effect arm the dismiss timer

    // Past the 5s default, an error is still readable.
    tick(6000);
    expect(screen.getByText('Could not reach the server')).toBeInTheDocument();

    tick(4000);
    expect(screen.queryByText('Could not reach the server')).not.toBeInTheDocument();
  });

  it('dismisses on the close button', () => {
    renderHarness();
    click('ok');
    clickByName('Dismiss');

    tick(300);
    expect(screen.queryByText('Submission saved')).not.toBeInTheDocument();
  });

  it('runs the action and closes the toast', () => {
    renderHarness();
    click('undoable');
    clickByName('Undo');

    expect(onUndo).toHaveBeenCalledTimes(1);
    tick(300);
    expect(screen.queryByText('Deleted')).not.toBeInTheDocument();
  });

  it('stacks concurrent toasts and caps the stack at five', () => {
    renderHarness();
    for (let i = 0; i < 7; i++) click('info');

    expect(screen.getAllByText('Syncing')).toHaveLength(5);
  });

  it('clears everything on hideAll', () => {
    renderHarness();
    click('ok');
    click('fail');
    click('clear');

    expect(screen.queryByText('Submission saved')).not.toBeInTheDocument();
    expect(screen.queryByText('Could not reach the server')).not.toBeInTheDocument();
  });

  it('throws a useful error when used outside the provider', () => {
    // React logs the thrown render error; silence it for this one assertion.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => render(<Harness />)).toThrow('useToast must be used inside <ToastProvider>');
    spy.mockRestore();
  });
});
