import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { TestDataProvider, TestTag, useTestHighlight, useTestRow } from './testData';

/**
 * The shared test-data marking.
 *
 * What is worth pinning here is the contract every table depends on and none of
 * them re-implements: that the marking is on by default, that one switch turns
 * both halves off at once, and that adding the class never destroys the classes
 * a row already had. The last of those is the quiet one — several rows carry
 * `email-row`/`on` for selection, and a helper that dropped them would break the
 * selected-row styling on a screen nobody thought to re-test.
 */

/** A table whose one row exercises both halves of the marking. */
function Table({ isTestData, extra }: { isTestData: boolean; extra?: boolean }) {
  const testRow = useTestRow();
  return (
    <table>
      <tbody>
        <tr
          data-testid="row"
          className={extra ? testRow({ isTestData }, 'email-row', 'on') : testRow({ isTestData })}
        >
          <td>
            S-26-1001
            <TestTag on={isTestData} />
          </td>
        </tr>
      </tbody>
    </table>
  );
}

function Switch() {
  const { on, setOn } = useTestHighlight();
  return <button onClick={() => setOn(!on)}>{on ? 'on' : 'off'}</button>;
}

const mount = (ui: React.ReactNode) => render(<TestDataProvider>{ui}</TestDataProvider>);

describe('test-data highlighting', () => {
  beforeEach(() => localStorage.clear());

  it('marks a flagged row with both the class and the pill, by default', () => {
    mount(<Table isTestData />);
    expect(screen.getByTestId('row')).toHaveClass('is-test');
    expect(screen.getByText('Test')).toBeInTheDocument();
  });

  it('leaves an ordinary row completely untouched', () => {
    mount(<Table isTestData={false} />);
    // No class at all, rather than class="" — the attribute is simply absent.
    expect(screen.getByTestId('row')).not.toHaveAttribute('class');
    expect(screen.queryByText('Test')).not.toBeInTheDocument();
  });

  it('keeps the classes a row already carried', () => {
    mount(<Table isTestData extra />);
    const row = screen.getByTestId('row');
    expect(row).toHaveClass('email-row');
    expect(row).toHaveClass('on');
    expect(row).toHaveClass('is-test');
  });

  it('is on when the preference has never been set', () => {
    // The failure this prevents is silent, so nobody should have to go and
    // switch it on to be told a row is a rehearsal.
    mount(<Switch />);
    expect(screen.getByRole('button')).toHaveTextContent('on');
  });

  it('turns both the tint and the pill off together', async () => {
    mount(
      <>
        <Switch />
        <Table isTestData />
      </>,
    );
    await userEvent.click(screen.getByRole('button'));

    expect(screen.getByTestId('row')).not.toHaveAttribute('class');
    expect(screen.queryByText('Test')).not.toBeInTheDocument();
  });

  it('remembers the choice across a reload', async () => {
    const first = mount(<Switch />);
    await userEvent.click(screen.getByRole('button'));
    first.unmount();

    mount(<Switch />);
    expect(screen.getByRole('button')).toHaveTextContent('off');
  });

  it('draws nothing for a payload that does not carry the flag at all', () => {
    // Older payloads and shapes the flag does not apply to (report aggregates)
    // must render exactly as before rather than throwing or marking everything.
    function Untyped() {
      const testRow = useTestRow();
      return <div data-testid="row" className={testRow(undefined)} />;
    }
    mount(<Untyped />);
    expect(screen.getByTestId('row')).not.toHaveAttribute('class');
  });
});
