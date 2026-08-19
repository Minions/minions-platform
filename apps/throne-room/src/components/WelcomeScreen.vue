<template>
  <div class="welcome-overlay">
    <div class="welcome-modal">
      <div class="welcome-content">
        <h1>Welcome, Overlord</h1>

        <p class="intro">
          Congratulations! You've just taken your seat in the <strong>Throne Room</strong>:
          the beating heart of your <strong>Lair</strong>.
        </p>

        <p>
          Like any good lair, yours hosts a small army of <em>functional chaos</em>.
          Your <strong>Minions</strong> are at your command: a swarm of demented little doers
          that will, more or less, accomplish whatever objective you set. They don't even need
          clear instructions (which is both their superpower and your daily headache).
        </p>

        <p>
          Around you, your <strong>Secretaries</strong> buzz: a cabinet of Minions who are
          just coherent enough to help you make sense of the chaos.
        </p>

        <p>
          They interpret your unclear wishes. They summarize what's on fire. They ask just
          enough clarifying questions to keep the Lair from imploding. Their job is to make
          <em>your</em> job possible.
        </p>

        <p class="job-statement">
          Your job? <strong>Get things done.</strong>
        </p>

        <div class="section">
          <h2>🪞 The Throne Room</h2>
          <p>
            Here's where you live, Overlord. You sit at the center, surrounded by displays,
            chatter, and the occasional explosion (of insight?). Your Secretaries manage your
            focus, surfacing exactly what you need to see, when you need to see it.
          </p>
        </div>

        <div class="section">
          <h2>🧩 The Shape of the Lair</h2>
          <p>
            Beyond the Throne Room stretch the <strong>Wings</strong> — zones of specialized
            activity. Each Wing has its own flavor, rhythm, and favorite kind of disaster.
            That's where Minions work: twitchy, overcaffeinated, and alarmingly enthusiastic.
          </p>
          <p>
            Your Minions can take on <em>roles</em> at will. Give one a <strong>Manual</strong>,
            and it becomes an expert in a new discipline within moments. Hand them a
            <strong>Gadget</strong>, and they'll wield it like it's been part of them forever.
            These are not stable beings. They are adaptable, duct-taped brilliance. And more
            importantly, they are infinitely disposable.
          </p>
          <p>
            Inside the <strong>Closet</strong> you'll find the Manuals, Gadgets, and Policies
            that shape how Minions behave. When a Mission begins, Minions rush to the Closet
            to gear up, argue, and transform.
          </p>
        </div>

        <div class="section">
          <h2>⚙️ How Things Actually Get Done</h2>
          <ol>
            <li>You decide what needs doing.</li>
            <li>You express your desire (vaguely or otherwise).</li>
            <li>Your Secretaries interpret, translate, and relay your intent.</li>
            <li>Somewhere in the Wings, Minions spring into motion.</li>
            <li>They recruit others, grab gadgets, inhale manuals, and get to work.</li>
            <li>When they need more info, they guess and then gabble unintelligibly to your Secretaries, who get answers and get them back on track.</li>
            <li>Result or mess, their work all ends up in <strong>source control</strong>.</li>
          </ol>
          <p>
            Minions work <em>atomically</em>. They never step on each other's toes, though
            they may gnaw on the same problem from different angles.
          </p>
        </div>

        <div class="section tips">
          <h2>💡 Tips for a Sane Overlord</h2>
          <ul>
            <li><strong>Speak plainly.</strong> The Secretaries will do their best, but Minions don't infer tone.</li>
            <li><strong>Don't micromanage.</strong> It only encourages them.</li>
            <li><strong>Keep the Closet organized.</strong> A mislabeled manual can turn an audit into an interpretive dance.</li>
            <li><strong>Let Git be your memory.</strong> It's the only thing here that's truly reliable.</li>
          </ul>
        </div>

        <div class="section closing">
          <h2>🎯 The Job</h2>
          <p>
            Being an Overlord isn't about barking orders. It's about <em>framing reality</em>.
            You're the one who defines what "done" means, and the minions fill in the messy details.
          </p>
          <p>
            When they swarm in the right direction, you'll feel it: that sweet moment when
            automation meets intention and things actually work.
          </p>
          <p>
            Your Throne Room is the living command center of organized chaos. Sit down.
            Take a sip. Issue your next thought.
          </p>
          <p class="final-line">
            Welcome to the Lair, Overlord.<br>
            Now go get some s*** done.
          </p>
        </div>

        <div class="actions">
          <button class="proceed" @click="$emit('dismiss')">
            Enter the Throne Room
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
// Component emits a 'dismiss' event when the user wants to proceed
defineEmits<{
  dismiss: [];
}>();
</script>

<style scoped>
.welcome-overlay {
  position: fixed;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  background: rgba(0, 0, 0, 0.85);
  display: flex;
  justify-content: center;
  align-items: center;
  z-index: 9999;
  padding: 20px;
  overflow: auto;
}

.welcome-modal {
  background: white;
  border-radius: 12px;
  max-width: 800px;
  width: 100%;
  max-height: 90vh;
  overflow-y: auto;
  box-shadow: 0 10px 40px rgba(0, 0, 0, 0.3);
}

.welcome-content {
  padding: 40px;
}

h1 {
  color: #1976d2;
  font-size: 2.5em;
  margin: 0 0 20px 0;
  text-align: center;
}

h2 {
  color: #333;
  font-size: 1.5em;
  margin: 20px 0 12px 0;
}

p {
  line-height: 1.6;
  color: #444;
  margin: 12px 0;
}

.intro {
  font-size: 1.1em;
  color: #333;
}

.job-statement {
  font-size: 1.2em;
  text-align: center;
  margin: 20px 0;
  padding: 16px;
  background: #f5f5f5;
  border-left: 4px solid #1976d2;
}

.section {
  margin: 30px 0;
  padding: 20px;
  background: #fafafa;
  border-radius: 8px;
}

.section.tips ul {
  list-style: none;
  padding: 0;
}

.section.tips li {
  margin: 8px 0;
  padding-left: 24px;
  position: relative;
}

.section.tips li::before {
  content: "→";
  position: absolute;
  left: 0;
  color: #1976d2;
  font-weight: bold;
}

.section ol {
  padding-left: 24px;
}

.section ol li {
  margin: 8px 0;
}

.section.closing {
  background: #e3f2fd;
  border: 2px solid #1976d2;
}

.final-line {
  font-size: 1.1em;
  font-weight: 600;
  text-align: center;
  margin-top: 20px;
  color: #1976d2;
}

.actions {
  margin-top: 30px;
  text-align: center;
}

.proceed {
  padding: 14px 32px;
  font-size: 1.1em;
  font-weight: 600;
  background: #1976d2;
  color: white;
  border: none;
  border-radius: 6px;
  cursor: pointer;
  transition: all 0.2s;
}

.proceed:hover {
  background: #1565c0;
  transform: translateY(-2px);
  box-shadow: 0 4px 12px rgba(25, 118, 210, 0.3);
}

strong {
  color: #1976d2;
  font-weight: 600;
}

em {
  color: #666;
  font-style: italic;
}

/* Scrollbar styling for webkit browsers */
.welcome-modal::-webkit-scrollbar {
  width: 8px;
}

.welcome-modal::-webkit-scrollbar-track {
  background: #f1f1f1;
  border-radius: 0 12px 12px 0;
}

.welcome-modal::-webkit-scrollbar-thumb {
  background: #888;
  border-radius: 4px;
}

.welcome-modal::-webkit-scrollbar-thumb:hover {
  background: #555;
}
</style>
