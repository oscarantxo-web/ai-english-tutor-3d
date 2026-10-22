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

    transcriptText.textContent = final || interim || "...";

    if (final.trim().length > 0) {
      stopListening();
      processUserInput(final.trim());
    }
  };

  recognition.onerror = (event) => {
    console.error("Speech Recognition Error:", event.error);
    stopListening();
    sessionStatus.textContent = "Listo para conversar";
  };

  recognition.onend = () => {
    stopListening();
  };
}

function startListening() {
  if (state.isSpeaking) {
    window.speechSynthesis.cancel();
    state.isSpeaking = false;
  }
  if (!recognition) {
    alert("Tu navegador no soporta reconocimiento de voz. Usa Google Chrome o Microsoft Edge.");
    return;
  }
  try {
    recognition.start();
  } catch (e) {
    console.warn(e);
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

  window.speechSynthesis.cancel(); // Stop any pending speech

  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = 'en-US';
  utterance.rate = state.speechRate;

  const voices = window.speechSynthesis.getVoices();
  const chosenVoice = voices.find(v => v.name === voiceSelect.value) ||
                      voices.find(v => v.lang.startsWith('en')) || voices[0];
  if (chosenVoice) utterance.voice = chosenVoice;

  utterance.onstart = () => {
    state.isSpeaking = true;
    talkIntensity = 0.85;
    speakingIndicator.classList.remove('hidden');
    sessionStatus.textContent = "Sarah está hablando...";
  };

  utterance.onboundary = (event) => {
    // Pulse intensity on every word boundary
    talkIntensity = 0.9;
  };

  utterance.onend = () => {
    state.isSpeaking = false;
    talkIntensity = 0;
    speakingIndicator.classList.add('hidden');
    sessionStatus.textContent = "Lista para conversar";

    // Hands-free mode: auto start listening after Sarah finishes
    if (state.handsFree) {
      setTimeout(() => {
        if (!state.isSpeaking && !state.isGenerating) {
          startListening();
        }
      }, 600);
    }
  };

  utterance.onerror = () => {
    state.isSpeaking = false;
    talkIntensity = 0;
    speakingIndicator.classList.add('hidden');
  };

  tutorText.textContent = text;

  // Show/Hide Feedback
  if (feedback && feedback.trim().length > 0) {
    feedbackText.textContent = feedback;
    feedbackCard.classList.remove('hidden');
  } else {
    feedbackCard.classList.add('hidden');
  }

  window.speechSynthesis.speak(utterance);
}

/* ================= Gemini AI Tutor Connector ================= */
let cachedValidModels = null;

async function getSupportedModels(apiKey) {
  if (cachedValidModels && cachedValidModels.length > 0) {
    return cachedValidModels;
  }

  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
    if (res.ok) {
      const data = await res.json();
      const models = (data.models || [])
        .filter(m => m.supportedGenerationMethods && m.supportedGenerationMethods.includes('generateContent'))
        .map(m => m.name.replace('models/', ''));

      console.log("Modelos habilitados en tu cuenta:", models);

      if (models.length > 0) {
        // Prioritize flash models first, then pro, then others
        models.sort((a, b) => {
          const aFlash = a.includes('flash') ? -1 : 1;
          const bFlash = b.includes('flash') ? -1 : 1;
          return aFlash - bFlash;
        });

        cachedValidModels = models;
        return cachedValidModels;
      }
    }
  } catch (e) {
    console.warn("No se pudo listar modelos dinámicamente:", e);
  }

  return ['gemini-3.8-flash', 'gemini-3.1-pro-preview'];
}

async function callGeminiWithFallback(apiKey, payload) {
  const models = await getSupportedModels(apiKey);
  let lastError = null;

  for (const model of models) {
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    
    try {
      console.log(`Intentando llamada con modelo: ${model}...`);
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (response.ok) {
        const data = await response.json();
        console.log(`¡Éxito con modelo ${model}!`);
        return data;
      }

      const errData = await response.json().catch(() => ({}));
      const errMsg = errData.error?.message || `HTTP ${response.status}`;
      console.warn(`Modelo ${model} no disponible: ${errMsg}`);
      lastError = new Error(errMsg);

      // If high demand, wait a moment before trying the next model
      if (errMsg.includes('high demand') || errMsg.includes('overloaded') || response.status === 503) {
        await new Promise(r => setTimeout(r, 600));
      }
    } catch (networkErr) {
      lastError = networkErr;
    }
  }

  throw lastError || new Error("No se pudo conectar con ningún modelo de Gemini.");
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

  const systemInstruction = `You are Sarah, an attentive, enthusiastic, and patient native English conversation and pronunciation coach in a spoken voice app like Praktica.
Current conversation scenario: ${topicContexts[state.topic] || "Casual conversation"}.

YOUR DUAL ROLE:
1. CONVERSATION PARTNER:
   - Always listen closely and react to what the student said. If they propose a topic or answer your question, acknowledge it enthusiastically!
   - Keep your spoken reply punchy, natural, and concise (1 to 2 sentences maximum).
   - Always end with a follow-up question to keep the student talking.

2. SPEAKING & PRONUNCIATION COACH:
   - Scrutinize what the student said for:
     a) Grammar or tense mistakes (e.g., "Yesterday I go" -> "went", "I have 25 years" -> "I am 25").
     b) Phrasing & Naturalness (e.g., saying just "sport" -> encourage "I'm a big fan of sports").
     c) Pronunciation & Phonetics (identify words in their sentence that are tricky for non-native speakers, silent letters, or common phonetic traps like: "comfortable", "schedule", "subtle", "island", "clothes", "vegetable", "doubt", or adding 'e' before 'sp'/'st' words).
   - If you detect ANY grammar mistake OR identify a tricky word worth coaching on pronunciation, provide a helpful, concise tip in Spanish with easy phonetics in the "feedback" field.
     Examples:
     - 'Gramática: Recuerda usar "went" para el pasado ("Yesterday I went...").'
     - 'Pronunciación: En "vegetable", la segunda "e" es muda: suena /ˈvɛdʒtəbəl/ ("VEJ-tuh-bul", 3 sílabas, no 4).'
     - 'Fluidez: En vez de solo "sport", di: "I love sports" o "Let\\'s talk about sports".'
   - If their sentence was completely natural, fluent, and had no pronunciation traps, set "feedback" to null.

OUTPUT FORMAT:
Respond strictly in valid JSON without backticks:
{
  "reply": "Your spoken English response (1-2 sentences with follow-up question)",
  "feedback": "Concise Spanish tip for grammar, phrasing, or pronunciation (or null)"
}`;

  // Add user turn to conversation history
  state.history.push({
    role: "user",
    parts: [{ text: userMessage }]
  });

  try {
    const payload = {
      system_instruction: {
        parts: [{ text: systemInstruction }]
      },
      contents: state.history.slice(-8), // Last 8 exchanges to keep context fresh and fast
      generationConfig: {
        temperature: 0.7,
        maxOutputTokens: 250,
        responseMimeType: "application/json"
      }
    };

    const data = await callGeminiWithFallback(state.apiKey, payload);
    const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text;

    let parsedResult;
    try {
      parsedResult = JSON.parse(rawText);
    } catch (e) {
      parsedResult = { reply: rawText, feedback: null };
    }

    // Save assistant reply to history
    state.history.push({
      role: "model",
      parts: [{ text: parsedResult.reply }]
    });

    state.isGenerating = false;
    speakResponse(parsedResult.reply, parsedResult.feedback);

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
