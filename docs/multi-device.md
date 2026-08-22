# More than one device

Everything the app does normally happens inside one browser: the control tab,
the projector tabs, and a `BroadcastChannel` between them. That is what lets it
be a static site with no server, no account and no network — and it stops at the
edge of the machine.

Two things want to be past that edge. A **phone in your pocket**, so the show
can be run from where the show is actually seen rather than from the laptop; and
a **second computer**, because the projector covering the side of the house is
plugged into a different one.

Both are the same mechanism: a small server on the machine holding the show,
serving the app and relaying the messages the tabs already send each other.

- [Starting it](#starting-it)
- [The remote](#the-remote)
- [Drawing on the house](#drawing-on-the-house)
- [A second computer driving projectors](#a-second-computer-driving-projectors)
- [Why the clock is the hard part](#why-the-clock-is-the-hard-part)
- [What does not cross the link](#what-does-not-cross-the-link)
- [Who can join](#who-can-join)
- [How it fits together](#how-it-fits-together)

## Starting it

On the machine driving the projectors, in the project folder:

```bash
node server.mjs
```

It prints the addresses to use:

```
Facade Mapper — serving this folder, link open.

  Control (this machine)   http://localhost:8000/
  Phone remote             http://192.168.1.23:8000/remote.html
  Second laptop            http://192.168.1.23:8000/projector.html
```

The **Devices** button in the control tab's top bar repeats those addresses,
including the drawing page for a tablet.

No dependencies and no install — it is Node's own HTTP server with a WebSocket
written by hand on top of it, which is roughly two hundred lines and the reason
there is no `package.json` in this project.

**Open the control page at `localhost`, not at the network address.** Camera
access needs a secure context, which means HTTPS or localhost, and a LAN address
is neither: the alignment camera will not start. Everything else is happy on
either.

Devices are joined together as soon as they load a page from that address. The
control tab's **Devices** button in the top bar says how many are on, and
carries the addresses to type into a phone.

## The remote

`remote.html` is a show controller, not a second copy of the editor. It has the
things you want in your hand out in the dark:

- **Blackout**, big enough to hit without looking.
- **Scenes** — one tap each, the live one lit.
- **Triggers** — fire one by hand, with its cooldown counting down on the button.
- **Play, pause, stop and the playlist.**
- **Master brightness.**
- Behind a disclosure: effects on and off, and per-projector blackout with a
  **Flash** button that makes one projector identify itself, which is the only
  practical way to tell three of them apart from the garden.

It holds no project. The control tab sends it a couple of kilobytes describing
what the show is doing, several times a second, and it sends back what was
pressed. That asymmetry is deliberate — one authority over the project is what
the whole design rests on, and a remote that cannot edit cannot conflict with
the laptop somebody is working at. It also means a remote can be closed, lost or
run out of battery mid-evening without the show noticing.

The page asks to keep the screen awake, and it lays itself out for whatever it
is on: a phone gets one column of thumb-sized buttons, a laptop gets the same
controls spread out.

## Drawing on the house

`draw.html` on an iPad, with an Apple Pencil or a finger. What you draw is on
the wall while the pencil is still moving.

1. Run `node server.mjs` on the machine driving the projectors, if it is not
   already running — the tablet is a second device, so it needs the link
   server. **Devices** in the control tab's top bar prints the address.
2. In the control tab, add the **Live drawing** effect and point it at a wall,
   a window, or nothing at all — a layer with no targets covers the whole
   facade, which is usually what you want to draw on.
3. Open the drawing address on the tablet. If there is no drawing layer yet the
   page offers to ask the control tab for one, so you do not have to walk back
   indoors to press a button.
4. Draw.

There is nothing to switch on beyond that: the effect is in the **basic**
category of the effect gallery, called **Live drawing**, and `draw.html` is
served by the same server as everything else.

The page shows the area you are drawing into as a dashed box, with the rest of
the traced facade faint around it, so a window you are drawing on has the door
and the roofline in the right places off its edges. Colour, width, rub out,
undo and clear are along the bottom, and the bars fade out of the way while the
pencil is down.

**Pressure** drives the width of the line, which is most of the difference
between a drawn stroke and a plotted one. **Pencil** — the toggle at the end of
the bar — turns on automatically the first time a stylus is seen, and stops the
heel of your hand drawing while you write.

### What is actually sent

A stroke beginning, a handful of points, a stroke ending. Nothing the size of a
drawing, and never anything that touches the project — the project is broadcast
whole and saved on every change, and putting a pencil in that path would rewrite
the entire show sixty times a second. Every tab in the show applies the same
messages and arrives at the same picture, the same way every tab in the show
runs the same seeded generator: two projectors covering one wall have to agree
about what is drawn on it.

Coordinates are normalised to the target shape's own box, so a drawing lands on
the window it was drawn for whatever the camera resolution is, follows the shape
if it is re-traced, and appears on all four windows at once if the layer points
at four.

A tab that opens later has missed every stroke, so it asks for the drawing and
is sent the lot in one message — from the control tab, which keeps a copy of
everything, or from the tablet itself if the control tab has been reloaded since
the drawing was made.

Drawing is *not* saved with the show. It lives as long as the tabs do, which
suits what it is for; export a screenshot if you drew something you want to keep.

## A second computer driving projectors

Open `http://<address>/projector.html` on it and pick a projector, exactly as
you would on the show machine. It receives the project, the transport and the
clock over the link, and renders identically.

Everything else stays where it was. Alignment, tracing and calibration are done
from the control tab on the machine with the camera; the second computer is an
output, not a second editor.

## Why the clock is the hard part

Show time is a subtraction: every tab computes `(now - showStartEpoch) / 1000`
and lands on the same frame without asking anybody. On one machine that is free,
because every tab reads one system clock.

Two machines do not agree. A laptop that has been shut in a shed since last
autumn is routinely a second or more away from the one in the hall, and a second
is an eternity: two projectors covering the same brickwork would paint two
different frames of the same animation, which does not read as a timing problem
— it reads as one projector running the wrong show.

So every device measures its own offset from the server's clock, the way NTP
does. It sends a timestamp, the server stamps its reply, and the round trip
bounds the error. The fastest of the last few round trips wins, because a fast
one has little room to be lopsided; a packet that sat in a queue on the way back
reports an offset skewed by half of however long it waited. From then on, every
wall-clock number that leaves a machine — the transport's start epoch, scene
change times, layer switch-ons — is written and read in that shared time.

Corrections after the first are eased in at 5% of real time rather than applied
at once. A step correction is a jump in show time, and a jump in show time is
every particle in every effect teleporting simultaneously — far more noticeable
than the 80 ms of error being fixed.

The control tab's **Devices** dialog and each projector tab's status overlay
(<kbd>I</kbd>) show the measured offset. On the machine running the server it
reads as "in step". Somewhere else it reads as however wrong that machine's
clock is, which is the first thing to look at if two projectors disagree.

## What does not cross the link

- **Media.** Videos and images live in the browser's IndexedDB on the machine
  they were imported to, and are not sent over the link. A video effect on a
  second computer will draw nothing and say so. Import the media on that machine
  too, or keep video on the projectors driven by the show machine.
- **Drawing**, in the other direction, does cross — it is show state rather than
  show content, and small enough to send as it happens.
- **The camera.** It belongs to the tab that opened it. Alignment, motion
  triggers and camera-feed effects run on the show machine.
- **Sound.** Trigger sounds play from the control tab only, as they always have.
- **Editing.** Only the control tab writes the project. There is no locking to
  get wrong because there is nothing to lock.

One practical consequence: **leave the control tab visible.** A browser stops
rendering a tab that is hidden behind another window, and the control tab is
what advances the playlist and watches for motion. Pressing things on a remote
works either way — that arrives as a message and is acted on immediately, holds
included — but a control tab nobody can see is a show that has stopped counting.

## Who can join

Anything that can reach the address. On a home network that is the household,
which for a show projected onto the front of the house is usually the right
answer.

If it is not — a venue, a shared network, a neighbour who thinks this is funny —
start it with a key:

```bash
node server.mjs --key back-gate
```

Then the address becomes `http://192.168.1.23:8000/remote.html?key=back-gate`,
and anything without it is refused at the socket. The key is remembered by the
device, so a phone that has joined once keeps working after a reload and the key
does not have to stay in its address bar.

A remote can only do the things on its list — go to a scene, fire a trigger,
black out, set the master, switch an effect. It cannot edit the show, whatever
it sends.

## How it fits together

```
  laptop in the hall                  garage laptop      phone      iPad
  ┌───────────────────────────┐       ┌───────────┐   ┌────────┐  ┌──────┐
  │ control tab               │       │ projector │   │ remote │  │ draw │
  │   ├ BroadcastChannel ─────┼─ same │    tab    │   │        │  │      │
  │   └ projector tabs        │  brwsr└─────┬─────┘   └───┬────┘  └──┬───┘
  │                           │             │             │          │
  │   server.mjs ◄────────────┴── WebSocket ┴─────────────┴──────────┘
  │     static files + relay + "what time do you make it?"
  └───────────────────────────┘
```

The server has no idea what a scene is. It forwards frames between devices,
skipping the ones that already have the message over BroadcastChannel, and it
answers the time. Everything that decides anything stays in the browser.

Each connection says what it wants: a projector tab asks for everything, a
remote asks for the two small message types it can act on — so the project
broadcast, which is the whole show and goes out a dozen times a second while a
slider is moving, never goes near a phone.

The details are in [`server.mjs`](../server.mjs), [`js/core/link.js`](../js/core/link.js)
and [`js/core/time.js`](../js/core/time.js), and the reasoning about coordinate
spaces, the render path and the rest of the cross-tab design is in
[architecture](architecture.md).
