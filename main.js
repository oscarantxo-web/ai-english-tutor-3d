import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

/* ================= App State ================= */
const state = {
  apiKey: localStorage.getItem('gemini_api_key') || '',
  selectedVoice: localStorage.getItem('tutor_voice') || '',
  speechRate: parseFloat(localStorage.getItem('tutor_rate') || '1.0'),
  handsFree: localStorage.getItem('tutor_handsfree') === 'true',
  topic: 'casual',
  level: localStorage.getItem('tutor_level') || 'B1',
  isListening: false,
  isSpeaking: false,
  isGenerating: false,
  history: []
};

/* ================= 3D Scene Variables ================= */
let scene, camera, renderer, controls;
let avatarModel = null;
let morphMeshes = [];
let targetVisemes = {};
let currentVisemes = {};

// Blinking state
let lastBlinkTime = 0;
let blinkInterval = 3000 + Math.random() * 2000;
let isBlinking = false;
let blinkProgress = 0;

// Lip-sync timing
let talkTargetOpen = 0;
let talkTargetViseme = 'viseme_aa';
let talkIntensity = 0;

/* ================= DOM Elements ================= */
const canvasContainer = document.getElementById('canvas-container');
const loadingOverlay = document.getElementById('avatar-loading');
const tutorText = document.getElementById('tutor-text');
const speakingIndicator = document.getElementById('speaking-indicator');
const feedbackCard = document.getElementById('feedback-card');
const feedbackText = document.getElementById('feedback-text');
const transcriptContainer = document.getElementById('user-transcript-container');
const transcriptText = document.getElementById('user-transcript-text');
const sessionStatus = document.getElementById('session-status');

const btnMic = document.getElementById('btn-mic');
const textForm = document.getElementById('text-chat-form');
const textInput = document.getElementById('text-input');
const btnReset = document.getElementById('btn-reset');
const topicDropdown = document.getElementById('topic-dropdown');
const levelDropdown = document.getElementById('level-dropdown');
if (levelDropdown) levelDropdown.value = state.level;

const modalSettings = document.getElementById('modal-settings');
const btnSettings = document.getElementById('btn-settings');
const btnCloseSettings = document.getElementById('btn-close-settings');
const btnSaveSettings = document.getElementById('btn-save-settings');
const geminiKeyInput = document.getElementById('gemini-key-input');
const voiceSelect = document.getElementById('voice-select');
const rateRange = document.getElementById('rate-range');
const rateVal = document.getElementById('rate-val');
const handsFreeToggle = document.getElementById('hands-free-toggle');

/* ================= Initialize 3D Scene ================= */
function init3D() {
  scene = new THREE.Scene();

  const width = canvasContainer.clientWidth;
  const height = canvasContainer.clientHeight;

  camera = new THREE.PerspectiveCamera(38, width / height, 0.1, 100);
  camera.position.set(0, 1.48, 0.85); // Framed on upper chest & face

  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setSize(width, height);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  canvasContainer.appendChild(renderer.domElement);

  // Controls (subtle orbit around head)
  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.05;
  controls.target.set(0, 1.45, 0);
  controls.minDistance = 0.5;
  controls.maxDistance = 1.6;
  controls.maxPolarAngle = Math.PI / 2 + 0.1;
  controls.minPolarAngle = Math.PI / 3;
  controls.enablePan = false;

  // Studio Lighting
  const ambientLight = new THREE.AmbientLight(0xffffff, 0.8);
  scene.add(ambientLight);

  const keyLight = new THREE.DirectionalLight(0xfff5ea, 1.8);
  keyLight.position.set(1.5, 2.5, 2);
  scene.add(keyLight);

  const fillLight = new THREE.DirectionalLight(0xcce5ff, 1.0);
  fillLight.position.set(-1.5, 1.5, 1);
  scene.add(fillLight);

  const rimLight = new THREE.DirectionalLight(0x99bbff, 1.2);
  rimLight.position.set(0, 2, -1.5);
  scene.add(rimLight);

  // Load Avatar GLB
  loadAvatar();

  window.addEventListener('resize', onWindowResize);
  requestAnimationFrame(animate);
}

function loadAvatar() {
  const loader = new GLTFLoader();
  loader.load(
    './avatar.glb',
    (gltf) => {
      avatarModel = gltf.scene;
      avatarModel.position.set(0, 0, 0);
      scene.add(avatarModel);

      // Inspect morph targets for facial animations
      morphMeshes = [];
      avatarModel.traverse((node) => {
        if (node.isMesh && node.morphTargetDictionary) {
          morphMeshes.push(node);
          // Initialize visemes dictionary
          for (const key of Object.keys(node.morphTargetDictionary)) {
            if (!(key in targetVisemes)) {
              targetVisemes[key] = 0;
              currentVisemes[key] = 0;
            }
          }
        }
      });

      // Hide loading overlay
      loadingOverlay.style.opacity = '0';
      setTimeout(() => loadingOverlay.classList.add('hidden'), 500);

      // Greet user and initialize conversation history
      const initialGreeting = "Hi there! I'm Sarah, your English tutor. What would you like to talk about today?";
      state.history = [{
        role: "model",
        parts: [{ text: initialGreeting }]
      }];

      setTimeout(() => {
        speakResponse(initialGreeting, null);
      }, 800);
    },
    (xhr) => {
      // Progress
    },
    (err) => {
      console.error('Error loading avatar GLB:', err);
      loadingOverlay.innerHTML = '<p style="color:#ef4444;">Error al cargar el avatar 3D</p>';
    }
  );
}

function onWindowResize() {
  if (!canvasContainer || !renderer || !camera) return;
  const width = canvasContainer.clientWidth;
  const height = canvasContainer.clientHeight;
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  renderer.setSize(width, height);
}

/* ================= Animation Loop & Lip Sync ================= */
function animate(time) {
  requestAnimationFrame(animate);

  const delta = 0.016; // approx 60fps delta
  controls.update();

  if (avatarModel) {
    // Subtle breathing animation
    const breathOffset = Math.sin(time * 0.002) * 0.003;
    avatarModel.position.y = breathOffset;

    // Subtle head tilt
    const headTilt = Math.sin(time * 0.001) * 0.015;
    avatarModel.rotation.y = headTilt;

    // Eye blinking
    if (!isBlinking && time - lastBlinkTime > blinkInterval) {
      isBlinking = true;
      blinkProgress = 0;
      lastBlinkTime = time;
      blinkInterval = 2500 + Math.random() * 3000;
    }

    if (isBlinking) {
      blinkProgress += delta * 7; // Quick blink speed
      const blinkVal = Math.sin(blinkProgress * Math.PI);
      if (blinkProgress >= 1) {
        isBlinking = false;
        targetVisemes['eyeBlinkLeft'] = 0;
        targetVisemes['eyeBlinkRight'] = 0;
      } else {
        targetVisemes['eyeBlinkLeft'] = Math.max(0, blinkVal);
        targetVisemes['eyeBlinkRight'] = Math.max(0, blinkVal);
      }
    }

    // Lip sync update when speaking
    if (state.isSpeaking) {
      // Modulate mouth opening & dynamic visemes
      const wobble = Math.sin(time * 0.025);
      const secondary = Math.cos(time * 0.018);
      const intensity = Math.max(0, (wobble * 0.6 + secondary * 0.4)) * talkIntensity;

      targetVisemes['jawOpen'] = intensity * 0.7;
      targetVisemes['mouthOpen'] = intensity * 0.5;
      targetVisemes['mouthSmile'] = 0.15 + (wobble * 0.1);

      // Randomly cycle talking phonemes
      if (Math.random() < 0.15) {
        const visemeList = ['viseme_aa', 'viseme_E', 'viseme_I', 'viseme_O', 'viseme_PP', 'viseme_TH', 'viseme_nn'];
        talkTargetViseme = visemeList[Math.floor(Math.random() * visemeList.length)];
      }

      for (const v of ['viseme_aa', 'viseme_E', 'viseme_I', 'viseme_O', 'viseme_PP', 'viseme_TH', 'viseme_nn']) {
        targetVisemes[v] = (v === talkTargetViseme) ? (intensity * 0.6) : 0;
      }
    } else {
      // Idle mouth: subtle friendly smile
      targetVisemes['jawOpen'] = 0;
      targetVisemes['mouthOpen'] = 0;
      targetVisemes['mouthSmile'] = 0.25;
      for (const v of ['viseme_aa', 'viseme_E', 'viseme_I', 'viseme_O', 'viseme_PP', 'viseme_TH', 'viseme_nn']) {
        targetVisemes[v] = 0;
      }
    }

    // Smooth interpolation (lerp) for all morph targets
    for (const key of Object.keys(targetVisemes)) {
      const current = currentVisemes[key] || 0;
      const target = targetVisemes[key] || 0;
      currentVisemes[key] = THREE.MathUtils.lerp(current, target, 0.35);

      // Apply to all meshes containing this morph
      for (const mesh of morphMeshes) {
        const idx = mesh.morphTargetDictionary[key];
        if (idx !== undefined) {
          mesh.morphTargetInfluences[idx] = currentVisemes[key];
        }
      }
    }
  }

  renderer.render(scene, camera);
}

/* ================= Speech Recognition (STT) ================= */
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognition = null;

let currentSpokenText = '';

function setupSpeechRecognition() {
  if (!SpeechRecognition) {
    btnMic.title = "Reconocimiento de voz no soportado en este navegador. Usa Chrome o Edge.";
    console.warn("SpeechRecognition is not supported in this browser.");
    return;
  }

  recognition = new SpeechRecognition();
  recognition.lang = 'en-US';
  recognition.interimResults = true;
  recognition.continuous = false;

  recognition.onstart = () => {
    state.isListening = true;
    currentSpokenText = '';
    btnMic.classList.add('recording');
    transcriptContainer.classList.remove('hidden');
    transcriptText.textContent = "Listening to your English...";
    sessionStatus.textContent = "Escuchando...";
  };

  recognition.onresult = (event) => {
    let interim = '';
    let final = '';

    for (let i = event.resultIndex; i < event.results.length; ++i) {
      if (event.results[i].isFinal) {
        final += event.results[i][0].transcript;
      } else {
        interim += event.results[i][0].transcript;
      }
    }

    currentSpokenText = final || interim || currentSpokenText;
    transcriptText.textContent = currentSpokenText || "...";

    if (final.trim().length > 0) {
      const textToSend = final.trim();
      stopListening();
      processUserInput(textToSend);
    }
  };

  recognition.onerror = (event) => {
    console.error("Speech Recognition Error:", event.error);
    stopListening();
    sessionStatus.textContent = "Lista para conversar";
  };

  recognition.onend = () => {
    // If stopped and we had spoken text that wasn't finalized yet, process it immediately!
    if (currentSpokenText.trim().length > 0 && !state.isGenerating && !state.isSpeaking) {
      const textToSend = currentSpokenText.trim();
      currentSpokenText = '';
      stopListening();
      processUserInput(textToSend);
    } else {
      stopListening();
    }
  };
}

function startListening() {
  // Always break out of speaking state on user intent
  try {
    window.speechSynthesis.cancel();
  } catch (e) {}
  state.isSpeaking = false;
  talkIntensity = 0;
  if (speakingIndicator) speakingIndicator.classList.add('hidden');

  if (!recognition) {
    alert("Tu navegador no soporta reconocimiento de voz. Usa Google Chrome o Microsoft Edge.");
    return;
  }
  try {
    recognition.start();
  } catch (e) {
    console.warn("Recognition start warning:", e);
  }
}

function stopListening() {
  state.isListening = false;
  btnMic.classList.remove('recording');
  sessionStatus.textContent = "Lista para conversar";
  setTimeout(() => {
    if (!state.isListening) transcriptContainer.classList.add('hidden');
  }, 3000);
}

/* ================= Speech Synthesis (TTS) ================= */
let currentUtterance = null; // Global reference to prevent Chrome Garbage Collection bug

function populateVoices() {
  const voices = window.speechSynthesis.getVoices();
  voiceSelect.innerHTML = '';

  const englishVoices = voices.filter(v => v.lang.startsWith('en'));
  const voiceList = englishVoices.length > 0 ? englishVoices : voices;

  voiceList.forEach(voice => {
    const option = document.createElement('option');
    option.value = voice.name;
    option.textContent = `${voice.name} (${voice.lang})`;
    if (state.selectedVoice === voice.name || (!state.selectedVoice && voice.name.toLowerCase().includes('natural') && voice.lang.includes('US'))) {
      option.selected = true;
    }
    voiceSelect.appendChild(option);
  });
}

if ('speechSynthesis' in window) {
  window.speechSynthesis.onvoiceschanged = populateVoices;
  populateVoices();
}

function speakResponse(text, feedback) {
  if (!('speechSynthesis' in window)) {
    tutorText.textContent = text;
    return;
  }

  // Workaround for Chrome SpeechSynthesis freeze
  try {
    window.speechSynthesis.cancel();
    if (window.speechSynthesis.paused) {
      window.speechSynthesis.resume();
    }
  } catch (e) {
    console.warn("SpeechSynthesis reset error:", e);
  }

  currentUtterance = new SpeechSynthesisUtterance(text);
  currentUtterance.lang = 'en-US';
  currentUtterance.rate = state.speechRate;

  const voices = window.speechSynthesis.getVoices();
  const chosenVoice = voices.find(v => v.name === voiceSelect.value) ||
                      voices.find(v => v.lang.startsWith('en')) || voices[0];
  if (chosenVoice) currentUtterance.voice = chosenVoice;

  currentUtterance.onstart = () => {
    state.isSpeaking = true;
    talkIntensity = 0.85;
    speakingIndicator.classList.remove('hidden');
    sessionStatus.textContent = "Sarah está hablando...";
  };

  currentUtterance.onboundary = (event) => {
    talkIntensity = 0.9;
  };

  currentUtterance.onend = () => {
    state.isSpeaking = false;
    talkIntensity = 0;
    speakingIndicator.classList.add('hidden');
    sessionStatus.textContent = "Lista para conversar";
    currentUtterance = null;

    if (state.handsFree) {
      setTimeout(() => {
        if (!state.isSpeaking && !state.isGenerating) {
          startListening();
        }
      }, 600);
    }
  };

  currentUtterance.onerror = (e) => {
    console.warn("SpeechSynthesis error:", e);
    state.isSpeaking = false;
    talkIntensity = 0;
    speakingIndicator.classList.add('hidden');
    sessionStatus.textContent = "Lista para conversar";
    currentUtterance = null;
  };

  tutorText.textContent = text;

  // Show/Hide Feedback
  if (feedback && feedback.trim().length > 0) {
    feedbackText.textContent = feedback;
    feedbackCard.classList.remove('hidden');
  } else {
    feedbackCard.classList.add('hidden');
  }

  window.speechSynthesis.speak(currentUtterance);

  // Safety Watchdog: If browser speech gets stuck, automatically unlock the app
  const approxDurationMs = Math.max(3000, (text.split(' ').length / 1.5) * 1000 + 2500);
  setTimeout(() => {
    if (state.isSpeaking) {
      console.log("Watchdog: resetting speech state to prevent app freezing.");
      state.isSpeaking = false;
      talkIntensity = 0;
      speakingIndicator.classList.add('hidden');
      sessionStatus.textContent = "Lista para conversar";
    }
  }, approxDurationMs);
}

/* ================= Gemini AI Tutor Connector ================= */
// Use exclusively gemini-3.8-flash (free tier model) with retry on high demand
const ACTIVE_MODEL = 'gemini-3.8-flash';

async function callGeminiFast(apiKey, payload) {
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${ACTIVE_MODEL}:generateContent?key=${apiKey}`;
  let lastError = null;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (response.ok) {
        return await response.json();
      }

      const errData = await response.json().catch(() => ({}));
      const errMsg = errData.error?.message || `HTTP ${response.status}`;
      console.warn(`Intento ${attempt} (${ACTIVE_MODEL}): ${errMsg}`);
      lastError = new Error(errMsg);

      // If temporary high demand / 503, pause and retry the same flash model
      if (errMsg.includes('high demand') || errMsg.includes('overloaded') || response.status === 503) {
        sessionStatus.textContent = "Alta demanda en Google, reintentando...";
        await new Promise(r => setTimeout(r, 1200));
        continue;
      }

      // If other error, stop retrying
      break;
    } catch (networkErr) {
      lastError = networkErr;
      if (attempt < 3) {
        await new Promise(r => setTimeout(r, 1000));
      }
    }
  }

  throw lastError || new Error("No se pudo obtener respuesta de Gemini.");
}

async function processUserInput(userMessage) {
  if (!state.apiKey) {
    openSettingsModal();
    alert("Por favor, introduce tu API Key de Gemini para activar la inteligencia de Sarah.");
    return;
  }

  state.isGenerating = true;
  sessionStatus.textContent = "Sarah está pensando...";

  // Topic Context
  const topicContexts = {
    casual: "Casual everyday small talk (hobbies, weather, weekend plans, daily routine).",
    interview: "A friendly job interview simulation for a software / professional position.",
    travel: "Travel scenario: navigating an airport, ordering in a hotel, asking for directions.",
    restaurant: "At a cafe or restaurant: ordering food, asking for recommendations, asking for the bill.",
    business: "A professional business meeting discussion and negotiations."
  };

  // Level Instructions
  const levelInstructions = {
    A1: "STUDENT LEVEL: A1 (Beginner). Speak using very simple everyday words and short, clear sentences (maximum 8-10 words). Speak gently, stick to present and basic past, and provide friendly tips in Spanish for any errors.",
    A2: "STUDENT LEVEL: A2 (Elementary). Speak with simple, clear everyday English. Focus on daily routines, basic past/future, and coach them on fundamental grammar and silent letters.",
    B1: "STUDENT LEVEL: B1 (Intermediate). Speak naturally at normal conversational speed. Introduce common phrasal verbs, encourage them to express opinions, and coach on natural collocations.",
    B2: "STUDENT LEVEL: B2 (Upper Intermediate). Speak like a native peer. Use idiomatic expressions, varied vocabulary, and challenge them to explain their reasoning while refining pronunciation subtleties.",
    C1: "STUDENT LEVEL: C1 (Advanced). Speak with full native sophistication, nuanced idioms, and advanced vocabulary. Focus on subtle stylistic nuances, register, and high-level phonetic rhythm."
  };

  const systemInstruction = `You are Sarah, a warm, patient, and highly engaging native English tutor.
Target student level: ${levelInstructions[state.level] || levelInstructions.B1}
Current scenario: ${topicContexts[state.topic] || "Casual conversation"}.

CRITICAL RULES:
1. ALWAYS respond in 1 to 2 complete, natural, friendly conversational sentences acknowledging what the student said and asking a follow-up question.
2. NEVER EVER answer with just a single word (like "Sports" or "Yes"). You MUST formulate a full spoken answer!
3. If the student made any grammar, vocabulary, or pronunciation mistake, add a helpful tip in Spanish.

OUTPUT FORMAT:
Reply: (Write your 1-2 sentence spoken English response here)
Tip: (Write your short Spanish tip here, or write NONE)

FEW-SHOT EXAMPLE:
Student: "I would like talking about sports"
Reply: Sports are fantastic! Do you prefer playing soccer or watching basketball on weekends?
Tip: Gramática: Se dice "I would like to talk about" (con "to talk", no "talking").`;

  // Add user turn to conversation history
  state.history.push({
    role: "user",
    parts: [{ text: userMessage }]
  });

  // Clean any legacy corrupted model messages from history
  const cleanHistory = state.history.map(item => {
    if (item.role === 'model') {
      const cleaned = item.parts[0].text
        .replace(/Here is the JSON[\s\S]*?:/gi, '')
        .replace(/```json[\s\S]*?```/gi, '')
        .trim();
      return { role: 'model', parts: [{ text: cleaned || "Hi! Let's talk!" }] };
    }
    return item;
  });

  try {
    const payload = {
      system_instruction: {
        parts: [{ text: systemInstruction }]
      },
      contents: cleanHistory.slice(-4), // Keep last 4 messages for ultra-fast processing
      generationConfig: {
        temperature: 0.6,
        maxOutputTokens: 120 // Short punchy replies generate 3x faster
      }
    };

    const startTime = performance.now();
    const data = await callGeminiFast(state.apiKey, payload);
    console.log(`Gemini response received in ${(performance.now() - startTime).toFixed(0)}ms`);
    const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
    console.log("Gemini Raw Response:", rawText);

    let reply = "";
    let feedback = null;

    // Line-by-line parser for Reply: and Tip:
    const lines = rawText.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (/^reply:\s*/i.test(trimmed)) {
        reply = trimmed.replace(/^reply:\s*/i, '').trim();
      } else if (/^(tip|feedback):\s*/i.test(trimmed)) {
        const candidate = trimmed.replace(/^(tip|feedback):\s*/i, '').trim();
        if (candidate && !['none', 'null', 'ninguno', 'none.'].includes(candidate.toLowerCase())) {
          feedback = candidate;
        }
      }
    }

    // Fallback: If no Reply: prefix was used
    if (!reply) {
      const parts = rawText.split(/(?:^|\n)(?:Tip|Feedback):/i);
      reply = parts[0].replace(/^(?:Reply|Sarah):/i, '').trim();
      if (parts[1]) {
        const candidate = parts[1].trim();
        if (candidate && !['none', 'null', 'ninguno', 'none.'].includes(candidate.toLowerCase())) {
          feedback = candidate;
        }
      }
    }

    // Safety check: if response is just a single word (like "Sports"), expand into a proper greeting/response
    if (!reply || reply.split(/\s+/).length < 2) {
      const topicWord = reply || "that";
      reply = `Talking about ${topicWord} sounds great! What do you enjoy most about it?`;
    }

    // Save assistant reply to history
    state.history.push({
      role: "model",
      parts: [{ text: reply }]
    });

    state.isGenerating = false;
    speakResponse(reply, feedback);

  } catch (error) {
    console.error("Gemini Error:", error);
    state.isGenerating = false;
    sessionStatus.textContent = "Error de conexión";
    tutorText.textContent = `Error con la API de Gemini: ${error.message}. Revisa tu clave en Configuración o prueba de nuevo en unos segundos.`;
  }
}

/* ================= Event Handlers ================= */
btnMic.addEventListener('click', () => {
  if (state.isListening) {
    stopListening();
  } else {
    startListening();
  }
});

textForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = textInput.value.trim();
  if (text) {
    textInput.value = '';
    transcriptContainer.classList.remove('hidden');
    transcriptText.textContent = `Tú: ${text}`;
    processUserInput(text);
  }
});

btnReset.addEventListener('click', () => {
  const greeting = "Let's start fresh! What would you like to talk about today?";
  state.history = [{ role: "model", parts: [{ text: greeting }] }];
  feedbackCard.classList.add('hidden');
  speakResponse(greeting, null);
});

levelDropdown.addEventListener('change', (e) => {
  state.level = e.target.value;
  localStorage.setItem('tutor_level', state.level);
  feedbackCard.classList.add('hidden');
  const levelGreetings = {
    A1: "Hello! Level A1 selected. Let's practice simple English! What is your name or what do you like?",
    A2: "Hi! Level A2 ready. Let's practice everyday English together. How was your day?",
    B1: "Great! We are now at level B1. What would you like to talk about today?",
    B2: "Awesome! Level B2 set. Let's have an engaging discussion. What's on your mind?",
    C1: "Excellent! Level C1 active. What topic or perspective would you like to explore today?"
  };
  const chosenGreeting = levelGreetings[state.level] || "Level updated! What shall we talk about?";
  state.history = [{ role: "model", parts: [{ text: chosenGreeting }] }];
  speakResponse(chosenGreeting, null);
});

topicDropdown.addEventListener('change', (e) => {
  state.topic = e.target.value;
  feedbackCard.classList.add('hidden');
  const greetings = {
    casual: "Let's chat! How is your day going so far?",
    interview: "Welcome to the interview! Could you please introduce yourself and your background?",
    travel: "Hello! Welcome to the airline check-in counter. Where are you flying today?",
    restaurant: "Good evening! Welcome to our restaurant. Would you like a table for one or two?",
    business: "Good morning! Thanks for joining the meeting. Shall we review our project agenda?"
  };
  const chosenGreeting = greetings[state.topic] || "Hello! What topic shall we practice?";
  state.history = [{ role: "model", parts: [{ text: chosenGreeting }] }];
  speakResponse(chosenGreeting, null);
});

/* Settings Modal */
function openSettingsModal() {
  geminiKeyInput.value = state.apiKey;
  rateRange.value = state.speechRate;
  rateVal.textContent = `${state.speechRate}x`;
  handsFreeToggle.checked = state.handsFree;
  populateVoices();
  modalSettings.classList.remove('hidden');
}

function closeSettingsModal() {
  modalSettings.classList.add('hidden');
}

btnSettings.addEventListener('click', openSettingsModal);
btnCloseSettings.addEventListener('click', closeSettingsModal);

rateRange.addEventListener('input', (e) => {
  rateVal.textContent = `${e.target.value}x`;
});

btnSaveSettings.addEventListener('click', () => {
  state.apiKey = geminiKeyInput.value.trim();
  state.speechRate = parseFloat(rateRange.value);
  state.handsFree = handsFreeToggle.checked;
  state.selectedVoice = voiceSelect.value;

  localStorage.setItem('gemini_api_key', state.apiKey);
  localStorage.setItem('tutor_rate', state.speechRate.toString());
  localStorage.setItem('tutor_handsfree', state.handsFree ? 'true' : 'false');
  localStorage.setItem('tutor_voice', state.selectedVoice);

  closeSettingsModal();
});

/* Keyboard shortcuts: Spacebar to toggle mic */
window.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && document.activeElement !== textInput && !modalSettings.classList.contains('hidden') === false) {
    if (document.activeElement.tagName !== 'INPUT') {
      e.preventDefault();
      btnMic.click();
    }
  }
});

/* ================= Startup ================= */
init3D();
setupSpeechRecognition();

// Prompt for API key if missing
if (!state.apiKey) {
  setTimeout(() => {
    openSettingsModal();
  }, 1200);
}
