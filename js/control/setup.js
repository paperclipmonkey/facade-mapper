/**
 * The setup walkthrough.
 *
 * Getting a house mapped means visiting three panels in an order nothing tells
 * you, doing two things that are physical rather than on-screen (drag a window
 * to the right display; go outside in the dark), and knowing that alignment has
 * to happen before tracing because shapes are stored in camera coordinates. All
 * of that was documented and none of it was *visible*, which is a fair summary
 * of why the app read as unintuitive.
 *
 * So this is a checklist that knows the answers rather than a page of prose.
 * Every step reports its own state from what is actually true right now — the
 * camera is either running or it is not, a projector tab has either checked in
 * or it has not — and carries the button that does the thing. The first
 * incomplete step is expanded; everything above it collapses to a tick.
 *
 * The rule it exists to enforce: **align before you trace**. Everything you draw
 * is in camera coordinates, so tracing first and aligning afterwards is not a
 * different order, it is lost work.
 *
 * Above the list sits the demo offer, because the list read in order says "you
 * cannot do anything until you own a projector and it is dark outside" — which
 * is true of a real show and entirely the wrong first impression, since almost
 * all of it can be learned on a picture of a house that does not exist.
 */

import { el, clear } from './ui.js';

/** A projector tab that has checked in for this projector, if any. */
function peerFor(app, projectorId) {
  return app.presence.list().find((p) => p.projectorId === projectorId) || null;
}

/**
 * Projector tabs that look like they are sharing a display.
 *
 * Two tabs reporting the same screen origin are on the same monitor, which
 * means one projector is showing the other's output — invisible from the
 * control tab, and maddening to diagnose from the garden.
 */
function displayClashes(app) {
  const seen = new Map();
  const clashes = [];
  for (const projector of app.project.projectors) {
    const peer = peerFor(app, projector.id);
    if (!peer || peer.screenX === undefined) continue;
    const key = `${peer.screenX},${peer.screenY},${peer.screenW}x${peer.screenH}`;
    if (seen.has(key)) clashes.push([seen.get(key), projector.name]);
    else seen.set(key, projector.name);
  }
  return clashes;
}

/**
 * The steps, in the order they have to happen, each answering three questions:
 * is it done, what does it mean, and what do I press.
 */
function buildSteps(app) {
  const { projectors, shapes, layers } = app.project;
  const demo = !!app.project.settings?.isDemo;
  const live = projectors.filter((p) => peerFor(app, p.id));
  const aligned = projectors.filter((p) => p.calibration?.H);
  const fullscreen = projectors.filter((p) => peerFor(app, p.id)?.fullscreen);
  const clashes = displayClashes(app);

  const goto = (panel) => () => app.switchPanel(panel);
  const selectProjector = (projector, panel = 'projectors') => () => {
    app.select({ type: 'projector', id: projector.id });
    app.switchPanel(panel);
  };

  const firstUnaligned = projectors.find((p) => !p.calibration?.H);
  const firstOffline = projectors.find((p) => !peerFor(app, p.id));

  /**
   * On the demo house the four hardware steps have no work in them, so they
   * report themselves satisfied rather than nagging about a camera that is not
   * needed and a projector that does not exist. They stay in the list because
   * the point of the demo is to show you what a real setup involves.
   */
  const notNeeded = (step) => (demo
    ? { ...step, done: true, warn: false, status: 'Not needed on the demo house.', actions: [] }
    : step);

  const backdrop = app.camera.isRunning() || app.project.settings?.hasStill;

  return [
    notNeeded({
      id: 'camera',
      title: 'Get a picture of the house',
      done: backdrop,
      why: 'Everything you draw is drawn on this picture, and a live camera is also what watches '
        + 'the alignment dots. Put it on a tripod roughly where people will stand — if it moves '
        + 'later, your whole mapping moves with it. A photograph works for tracing in the meantime.',
      status: app.camera.isRunning()
        ? 'Camera running.'
        : app.project.settings?.hasStill
          ? 'Tracing on a still picture.'
          : 'Nothing to trace on yet.',
      actions: [{ label: 'Camera and backdrop', run: goto('settings'), primary: !backdrop }],
    }),
    notNeeded({
      id: 'projectors',
      title: 'Add a projector for each one you own',
      done: projectors.length > 0,
      why: 'One entry per physical projector. Each gets its own alignment, its own slice of the '
        + 'house, and its own browser tab.',
      status: projectors.length
        ? `${projectors.length} projector${projectors.length === 1 ? '' : 's'} set up.`
        : 'None yet.',
      actions: [{ label: 'Add projector', run: () => app.addProjector(), primary: !projectors.length }],
    }),
    notNeeded({
      id: 'tabs',
      title: 'Open a tab for each projector',
      done: projectors.length > 0 && live.length === projectors.length,
      why: 'Each projector is driven by its own browser tab, which you drag onto that projector\'s '
        + 'display. The control tab talks to them through the browser, so they all stay in step.',
      status: projectors.length
        ? `${live.length} of ${projectors.length} tab${projectors.length === 1 ? '' : 's'} connected.`
        : 'Add a projector first.',
      actions: firstOffline
        ? [{ label: `Open tab for ${firstOffline.name}`, run: () => app.openProjectorTab(firstOffline.id), primary: true }]
        : [{ label: 'Check again', run: () => app.rollCall() }],
    }),
    notNeeded({
      id: 'displays',
      title: 'Put each tab on its own display',
      /**
       * Deliberately not gated on fullscreen. A tab that is not fullscreen still
       * projects — you just get browser chrome on the brickwork — so stalling
       * the whole checklist on it would be wrong. Two tabs sharing a display is
       * a real error, though, and that does block.
       */
      done: projectors.length > 0 && live.length === projectors.length && clashes.length === 0,
      why: 'Drag each tab to the display its projector is plugged into, click into it and press F. '
        + 'This is the one step nothing can do for you — the browser will not move its own window '
        + 'between screens.',
      status: (() => {
        if (!live.length) return 'Waiting for projector tabs.';
        if (clashes.length) return `${clashes[0][0]} and ${clashes[0][1]} share a display.`;
        if (fullscreen.length < projectors.length) {
          return `${fullscreen.length} of ${projectors.length} fullscreen — press F in the rest.`;
        }
        return 'All fullscreen.';
      })(),
      warn: clashes.length > 0,
      actions: [{ label: 'Check again', run: () => app.rollCall() }],
    }),
    notNeeded({
      id: 'align',
      title: 'Align each projector with the camera',
      done: projectors.length > 0 && aligned.length === projectors.length,
      why: 'Each projector flashes dots one at a time and the camera works out which projector '
        + 'pixel hits which part of the house. Do it after dark — the dots have to out-shine '
        + 'everything else in frame. If the wall turns a corner, set Wall shape to a denser grid '
        + 'first.',
      status: projectors.length
        ? `${aligned.length} of ${projectors.length} aligned.`
        : 'Add a projector first.',
      actions: firstUnaligned
        // Opens the projector rather than firing the alignment straight off:
        // the Wall shape setting lives there and matters before you start, and
        // a calibration begun by accident costs a minute of standing in the dark.
        ? [{ label: `Align ${firstUnaligned.name}…`, run: selectProjector(firstUnaligned), primary: true }]
        : [{ label: 'Projectors', run: goto('projectors') }],
    }),
    {
      id: 'trace',
      title: 'Trace the windows, the door and the roofline',
      done: shapes.length > 0,
      // The reason this step is fifth and not first.
      why: demo
        ? 'Already done on the demo — five windows, a door, the roofline and the chimney, each '
          + 'tagged. Draw another with Area or Path to see how it goes, or drag a corner of one and '
          + 'watch the effect follow it.'
        : 'Now, and not before — everything you draw is stored in camera coordinates, so tracing '
        + 'before aligning is not a different order, it is work you will lose. Use Area for windows '
        + 'and doors, Path for rooflines and gutters, and tag them (window, door, roof) so one '
        + 'effect can light all of them.',
      status: shapes.length ? `${shapes.length} shape${shapes.length === 1 ? '' : 's'} traced.` : 'Nothing traced yet.',
      actions: [{ label: 'Shapes', run: goto('shapes'), primary: !shapes.length }],
    },
    {
      id: 'effects',
      title: 'Put light on them',
      done: layers.length > 0,
      why: 'The starter presets build a whole look out of whatever you have tagged, grading '
        + 'included. That is the fastest way to see something on the wall — then take it apart.',
      status: layers.length ? `${layers.length} effect${layers.length === 1 ? '' : 's'}.` : 'No effects yet.',
      actions: [{ label: 'Effects', run: goto('layers'), primary: !layers.length }],
    },
  ];
}

/**
 * The offer to skip the hardware entirely, or the reminder that you took it.
 *
 * Placed above the checklist because it changes what the checklist means. Read
 * in order, the list says "you cannot do anything until you own a projector and
 * it is dark outside", which is true and is also the wrong first impression: you
 * can do almost all of it on a picture of a house that does not exist.
 */
function renderDemoCard(node, app) {
  const demo = !!app.project.settings?.isDemo;
  // Only offered while there is nothing to lose. Once you have traced
  // something, a button that opens a different show is a trap rather than an
  // invitation.
  const untouched = !app.project.shapes.length && !app.project.settings?.hasStill;
  if (!demo && !untouched) return;

  const card = demo
    ? {
      title: 'You are on the demo house',
      body: 'Nothing here is a mock-up — the shapes, the effects, the alignment and the preview '
        + 'are the same code a real show runs. Change anything you like; your own shows are '
        + 'untouched and still in Shows.',
      label: 'Start my own show',
      run: () => app.startRealShow(),
    }
    : {
      title: 'No projector to hand?',
      body: 'Load a demo house and the whole app comes alive — a facade to trace on, windows and '
        + 'a door already traced, a projector already aligned, effects already running. Learn it '
        + 'indoors in daylight, then set the real one up knowing what each step is for.',
      label: 'Try the demo house',
      run: () => app.loadDemoHouse(),
    };

  const button = el('button', { type: 'button', class: 'btn small primary', text: card.label });
  button.addEventListener('click', card.run);
  node.appendChild(el('div', { class: 'setup-demo' }, [
    el('h3', { text: card.title }),
    el('p', { text: card.body }),
    el('div', { class: 'panel-actions' }, [button]),
  ]));
}

export function renderSetupGuide(node, app) {
  clear(node);
  renderDemoCard(node, app);
  const steps = buildSteps(app);
  const currentIndex = steps.findIndex((s) => !s.done);
  const complete = currentIndex === -1;

  node.appendChild(el('div', { class: 'setup-progress' }, [
    el('div', { class: 'setup-bar' }, [
      el('span', { style: `width:${(steps.filter((s) => s.done).length / steps.length) * 100}%` }),
    ]),
    el('p', {
      class: 'panel-note',
      text: complete
        ? 'Everything is set up. Come back to this list any night you move something.'
        : `Step ${currentIndex + 1} of ${steps.length}.`,
    }),
  ]));

  steps.forEach((step, index) => {
    const isCurrent = index === currentIndex;
    const item = el('div', {
      class: `setup-step${step.done ? ' done' : ''}${isCurrent ? ' current' : ''}${step.warn ? ' warn' : ''}`,
    });

    // Title above status rather than beside it: the panel is narrow, and a
    // two-column head wraps both halves into an unreadable stack.
    item.appendChild(el('div', { class: 'setup-head' }, [
      el('span', { class: 'setup-mark', text: step.done ? '✓' : String(index + 1) }),
      el('div', { class: 'setup-text' }, [
        el('span', { class: 'setup-title', text: step.title }),
        el('span', { class: 'setup-status', text: step.status }),
      ]),
    ]));

    // Only the step you are on explains itself. Seven paragraphs of rationale
    // on screen at once is the thing this replaced.
    if (isCurrent || step.warn) {
      item.appendChild(el('p', { class: 'setup-why', text: step.why }));
      const actions = el('div', { class: 'panel-actions' });
      for (const action of step.actions) {
        const btn = el('button', {
          type: 'button',
          class: `btn small${action.primary ? ' primary' : ''}`,
          text: action.label,
        });
        btn.addEventListener('click', action.run);
        actions.appendChild(btn);
      }
      item.appendChild(actions);
    }

    // A finished step is still clickable — you come back here after moving a
    // projector, and the thing you need is usually one you already ticked off.
    if (step.done && !isCurrent) {
      item.addEventListener('click', () => step.actions[0]?.run?.());
    }

    node.appendChild(item);
  });
}
