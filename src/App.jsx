import React, { useState, useEffect } from 'react';
import { initializeApp } from 'firebase/app';
import { getAuth, signInWithCustomToken, signInAnonymously, onAuthStateChanged } from 'firebase/auth';
import { getFirestore, doc, setDoc, collection, onSnapshot, deleteDoc, addDoc } from 'firebase/firestore';
import { 
  Upload, 
  FileAudio, 
  Play, 
  CheckCircle2, 
  XCircle, 
  Loader2, 
  Download, 
  Trash2, 
  FileText,
  Copy,
  AlertCircle,
  Cloud,
  History,
  Files,
  Folder,
  Plus,
  Check,
  Cpu,
  Key
} from 'lucide-react';

// --- Firebase Configuration ---
const firebaseConfig = window.__firebase_config ? JSON.parse(window.__firebase_config) : {};
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const appId = window.__app_id || 'default-app-id';

// --- AI Configuration ---
const API_MODEL_GEMINI = "gemini-2.5-flash"; 

const App = () => {
  const [user, setUser] = useState(null);
  const [projects, setProjects] = useState([]);
  const [activeProjectId, setActiveProjectId] = useState('default');
  const [files, setFiles] = useState([]); 
  const [isProcessing, setIsProcessing] = useState(false);
  const [selectedFileId, setSelectedFileId] = useState(null);
  const [errorMessage, setErrorMessage] = useState(null);
  const [isSyncing, setIsSyncing] = useState(true);
  const [showNewProjectInput, setShowNewProjectInput] = useState(false);
  const [newProjectName, setNewProjectName] = useState('');
  
  const [isDragging, setIsDragging] = useState(false);
  const [batchProgress, setBatchProgress] = useState({ current: 0, total: 0 });
  const [aiProvider, setAiProvider] = useState('gemini');

  // --- API Key State Management ---
  const [showKeyDialog, setShowKeyDialog] = useState(false);
  const [apiKeys, setApiKeys] = useState(() => {
    const savedKeys = localStorage.getItem('echobulk_api_keys');
    return savedKeys ? JSON.parse(savedKeys) : { gemini: '', openai: '' };
  });

  useEffect(() => {
    localStorage.setItem('echobulk_api_keys', JSON.stringify(apiKeys));
  }, [apiKeys]);

  const MAX_FILES_PER_PROJECT = 100;
  const BATCH_SIZE = 1; 
  const FREE_TIER_DELAY_MS = 15000; 

  // --- 1. Authentication ---
  useEffect(() => {
    const initAuth = async () => {
      try {
        if (window.__initial_auth_token) {
          await signInWithCustomToken(auth, window.__initial_auth_token);
        } else {
          await signInAnonymously(auth);
        }
      } catch (err) {
        setErrorMessage("Authentication failed. Progress will not be saved.");
      }
    };
    initAuth();
    const unsubscribe = onAuthStateChanged(auth, setUser);
    return () => unsubscribe();
  }, []);

  // --- 2. Projects Persistence ---
  useEffect(() => {
    if (!user) return;
    const projectsRef = collection(db, 'artifacts', appId, 'users', user.uid, 'projects');
    const unsubscribe = onSnapshot(projectsRef, (snapshot) => {
      const projectsList = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      if (projectsList.length === 0) {
        setDoc(doc(db, 'artifacts', appId, 'users', user.uid, 'projects', 'default'), {
          name: 'Main Project',
          timestamp: Date.now()
        });
      }
      setProjects(projectsList.sort((a, b) => a.timestamp - b.timestamp));
    });
    return () => unsubscribe();
  }, [user]);

  // --- 3. Transcripts Persistence ---
  useEffect(() => {
    if (!user || !activeProjectId) return;

    setIsSyncing(true);
    const transcriptsRef = collection(db, 'artifacts', appId, 'users', user.uid, 'projects', activeProjectId, 'transcripts');
    
    const unsubscribe = onSnapshot(transcriptsRef, (snapshot) => {
      const remoteFiles = snapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data(),
        isRemote: true 
      }));

      setFiles(prev => {
        const mergedRemoteFiles = remoteFiles.map(remote => {
          const existingFile = prev.find(p => p.id === remote.id);
          return existingFile && existingFile.file 
            ? { ...remote, file: existingFile.file } 
            : remote;
        });
        const localOnly = prev.filter(f => !f.isRemote && !remoteFiles.find(r => r.id === f.id));
        return [...mergedRemoteFiles, ...localOnly];
      });
      setIsSyncing(false);
    }, (err) => {
      setErrorMessage("Could not sync with cloud storage.");
      setIsSyncing(false);
    });

    return () => unsubscribe();
  }, [user, activeProjectId]);

  // --- File Handling ---
  const handleFileChange = (e) => {
    if (e.target.files) addFiles(Array.from(e.target.files));
  };

  const handleDragOver = (e) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = (e) => {
    e.preventDefault();
    setIsDragging(false);
  };

  const handleDrop = (e) => {
    e.preventDefault();
    setIsDragging(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      addFiles(Array.from(e.dataTransfer.files));
    }
  };

  const addFiles = (newFiles) => {
    const validAudioTypes = ['audio/mpeg', 'audio/wav', 'audio/mp3', 'audio/ogg', 'audio/m4a', 'audio/x-m4a', 'audio/webm'];
    let filteredFiles = newFiles.filter(file => validAudioTypes.includes(file.type));
    
    if (filteredFiles.length < newFiles.length) {
      setErrorMessage("Some files were skipped because they aren't supported audio formats.");
    }

    const currentProjectFilesCount = files.length;
    if (currentProjectFilesCount + filteredFiles.length > MAX_FILES_PER_PROJECT) {
      const allowedCount = MAX_FILES_PER_PROJECT - currentProjectFilesCount;
      filteredFiles = filteredFiles.slice(0, Math.max(0, allowedCount));
      setErrorMessage(`Project limit reached! A maximum of ${MAX_FILES_PER_PROJECT} files are allowed per project.`);
    }

    if (filteredFiles.length === 0) return;

    const fileObjects = filteredFiles.map(file => ({
      id: crypto.randomUUID(),
      file, 
      name: file.name,
      size: (file.size / (1024 * 1024)).toFixed(2) + ' MB',
      status: 'pending',
      transcript: '',
      error: null,
      isRemote: false,
      timestamp: Date.now(),
      projectId: activeProjectId
    }));

    setFiles(prev => [...prev, ...fileObjects]);
  };

  const removeFile = async (file) => {
    if (file.isRemote && user) {
      try {
        const docRef = doc(db, 'artifacts', appId, 'users', user.uid, 'projects', activeProjectId, 'transcripts', file.id);
        await deleteDoc(docRef);
      } catch (err) {
        setErrorMessage("Failed to delete from cloud.");
      }
    } else {
      setFiles(prev => prev.filter(f => f.id !== file.id));
    }
    if (selectedFileId === file.id) setSelectedFileId(null);
  };

  const createProject = async () => {
    if (!newProjectName.trim() || !user) return;
    try {
      const projectsRef = collection(db, 'artifacts', appId, 'users', user.uid, 'projects');
      const docRef = await addDoc(projectsRef, {
        name: newProjectName.trim(),
        timestamp: Date.now()
      });
      setActiveProjectId(docRef.id);
      setNewProjectName('');
      setShowNewProjectInput(false);
      setFiles([]); 
    } catch (err) {
      setErrorMessage("Failed to create project.");
    }
  };

  // --- API Utilities ---
  const fileToBase64 = (file) => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.readAsDataURL(file);
      reader.onload = () => resolve(reader.result.split(',')[1]);
      reader.onerror = (error) => reject(error);
    });
  };

  const transcribeAudio = async (fileObj, provider) => {
    let retries = 0;
    const maxRetries = 3;

    const attempt = async (delay) => {
      try {
        if (provider === 'openai') {
          if (fileObj.file.size > 25 * 1024 * 1024) throw new Error("OpenAI Whisper strict limit is 25MB per file.");

          const formData = new FormData();
          formData.append('file', fileObj.file);
          formData.append('model', 'whisper-1');

          const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${apiKeys.openai}` },
            body: formData
          });

          if (!response.ok) {
            if (response.status === 429 && retries < maxRetries) {
              retries++;
              await new Promise(res => setTimeout(res, delay));
              return attempt(delay * 2);
            }
            if (response.status === 401) throw new Error("Invalid OpenAI API Key. Please check your settings.");
            const errorData = await response.json().catch(() => ({}));
            throw new Error(errorData.error?.message || `OpenAI API Error: ${response.status}`);
          }

          const data = await response.json();
          if (!data.text) throw new Error("No transcript generated by OpenAI.");
          return data.text;
        }

        if (provider === 'gemini') {
          const base64Data = await fileToBase64(fileObj.file);
          const response = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/${API_MODEL_GEMINI}:generateContent?key=${apiKeys.gemini}`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                contents: [{
                  parts: [
                    { text: "Transcribe this audio file accurately. Include speaker labels if possible." },
                    { inlineData: { mimeType: fileObj.file.type, data: base64Data } }
                  ]
                }]
              })
            }
          );

          if (!response.ok) {
            if (response.status === 429 && retries < maxRetries) {
              retries++;
              await new Promise(res => setTimeout(res, delay));
              return attempt(delay * 2);
            }
            if (response.status === 400 && !apiKeys.gemini) throw new Error("Invalid Gemini API Key. Please check your settings.");
            const errorData = await response.json().catch(() => ({}));
            throw new Error(errorData.error?.message || `Gemini API Error: ${response.status}`);
          }

          const data = await response.json();
          const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
          if (!text) throw new Error("No transcript generated by Gemini.");
          return text;
        }
      } catch (err) {
        if (retries < maxRetries && err.message.includes('429')) {
          retries++;
          await new Promise(res => setTimeout(res, delay));
          return attempt(delay * 2);
        }
        throw err;
      }
    };
    return attempt(1000);
  };

  const startBulkProcessing = async () => {
    if (aiProvider === 'gemini' && !apiKeys.gemini.trim()) {
      setShowKeyDialog(true);
      return;
    }
    if (aiProvider === 'openai' && !apiKeys.openai.trim()) {
      setShowKeyDialog(true);
      return;
    }

    if (isProcessing) return;
    const pendingFiles = files.filter(f => !f.isRemote && (f.status === 'pending' || f.status === 'error'));
    if (pendingFiles.length === 0) return;

    setIsProcessing(true);
    setErrorMessage(null);
    setBatchProgress({ current: 0, total: pendingFiles.length });

    let completedInRun = 0;

    for (let i = 0; i < pendingFiles.length; i += BATCH_SIZE) {
      const batch = pendingFiles.slice(i, i + BATCH_SIZE);
      
      setFiles(prev => prev.map(f => batch.find(b => b.id === f.id) ? { ...f, status: 'processing' } : f));

      const batchPromises = batch.map(async (fileObj) => {
        try {
          const transcript = await transcribeAudio(fileObj, aiProvider);
          
          if (user) {
            const docRef = doc(db, 'artifacts', appId, 'users', user.uid, 'projects', activeProjectId, 'transcripts', fileObj.id);
            await setDoc(docRef, {
              name: fileObj.name,
              size: fileObj.size,
              transcript: transcript,
              status: 'completed',
              provider: aiProvider, 
              timestamp: Date.now()
            });
          } else {
            setFiles(prev => prev.map(f => f.id === fileObj.id ? { ...f, status: 'completed', transcript } : f));
          }
        } catch (err) {
          setFiles(prev => prev.map(f => f.id === fileObj.id ? { ...f, status: 'error', error: err.message } : f));
        } finally {
          completedInRun++;
          setBatchProgress(prev => ({ ...prev, current: completedInRun }));
        }
      });

      await Promise.all(batchPromises);

      if (i + BATCH_SIZE < pendingFiles.length) {
        await new Promise(res => setTimeout(res, FREE_TIER_DELAY_MS));
      }
    }
    
    setIsProcessing(false);
    setTimeout(() => setBatchProgress({ current: 0, total: 0 }), 3000); 
  };

  const downloadTranscript = (file) => {
    const element = document.createElement("a");
    const textFile = new Blob([file.transcript], {type: 'text/plain'});
    element.href = URL.createObjectURL(textFile);
    element.download = `${file.name.split('.')[0]}_transcript.txt`;
    document.body.appendChild(element);
    element.click();
    document.body.removeChild(element);
  };

  const downloadAllCombined = () => {
    const completedFiles = files.filter(f => f.status === 'completed');
    if (completedFiles.length === 0) return;

    const currentProject = projects.find(p => p.id === activeProjectId);
    let combinedText = `ECHOBULK COMBINED TRANSCRIPTS - ${currentProject?.name || 'Project'}\n`;
    combinedText += "Generated on: " + new Date().toLocaleString() + "\n";
    combinedText += "=".repeat(40) + "\n\n";

    completedFiles.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0)).forEach(file => {
      combinedText += `FILE: ${file.name}\n`;
      combinedText += `SIZE: ${file.size}\n`;
      combinedText += `AI USED: ${file.provider === 'openai' ? 'OpenAI Whisper' : 'Google Gemini'}\n`;
      combinedText += "-".repeat(20) + "\n";
      combinedText += file.transcript + "\n\n";
      combinedText += "=".repeat(40) + "\n\n";
    });

    const element = document.createElement("a");
    const textFile = new Blob([combinedText], {type: 'text/plain'});
    element.href = URL.createObjectURL(textFile);
    element.download = `bulk_${activeProjectId}_${new Date().toISOString().split('T')[0]}.txt`;
    document.body.appendChild(element);
    element.click();
    document.body.removeChild(element);
  };

  const copyToClipboard = (text) => {
    const textArea = document.createElement("textarea");
    textArea.value = text;
    document.body.appendChild(textArea);
    textArea.select();
    document.execCommand('copy');
    document.body.removeChild(textArea);
  };

  const selectedFileData = files.find(f => f.id === selectedFileId);
  const sortedFiles = [...files].sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
  const hasCompletedFiles = files.some(f => f.status === 'completed');
  const pendingFilesCount = files.filter(f => !f.isRemote && (f.status === 'pending' || f.status === 'error')).length;

  // --- LOGIC CHECK FOR INDICATOR ---
  const hasActiveKey = aiProvider === 'gemini' ? !!apiKeys.gemini?.trim() : !!apiKeys.openai?.trim();

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 font-sans flex flex-col md:flex-row relative">
      
      {/* --- API KEY DIALOG MODAL --- */}
      {showKeyDialog && (
        <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-md p-6 animate-in fade-in zoom-in-95 duration-200">
            <div className="flex justify-between items-center mb-6">
              <h2 className="text-xl font-bold text-slate-800 flex items-center gap-2">
                <Key className="w-5 h-5 text-blue-600" /> Setup API Keys
              </h2>
              <button onClick={() => setShowKeyDialog(false)} className="text-slate-400 hover:text-slate-600">
                <XCircle className="w-5 h-5" />
              </button>
            </div>
            
            <p className="text-sm text-slate-500 mb-6">
              EchoBulk runs directly in your browser. Your keys are saved securely to your local device and are never sent to our servers.
            </p>

            <div className="space-y-4">
              <div>
                <label className="block text-sm font-semibold text-slate-700 mb-1">Google Gemini API Key</label>
                <input 
                  type="password" 
                  value={apiKeys.gemini}
                  onChange={(e) => setApiKeys({...apiKeys, gemini: e.target.value})}
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none"
                  placeholder="AIzaSy..."
                />
                <p className="text-xs text-slate-500 mt-1">Get one free at <a href="https://aistudio.google.com/app/apikey" target="_blank" rel="noreferrer" className="text-blue-500 hover:underline">Google AI Studio</a>.</p>
              </div>
              
              <div>
                <label className="block text-sm font-semibold text-slate-700 mb-1">OpenAI API Key <span className="text-slate-400 font-normal">(Optional)</span></label>
                <input 
                  type="password" 
                  value={apiKeys.openai}
                  onChange={(e) => setApiKeys({...apiKeys, openai: e.target.value})}
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none"
                  placeholder="sk-..."
                />
              </div>
            </div>

            <button 
              onClick={() => setShowKeyDialog(false)}
              className="w-full mt-6 bg-slate-900 text-white font-bold py-2.5 rounded-lg hover:bg-slate-800 transition-colors"
            >
              Save & Close
            </button>
          </div>
        </div>
      )}

      <aside className="w-full md:w-64 bg-slate-900 text-slate-300 flex flex-col shrink-0 border-r border-slate-800">
        <div className="p-6 pb-4">
          <h1 className="text-xl font-bold text-white flex items-center gap-2">
            <FileAudio className="text-blue-500 w-6 h-6" />
            EchoBulk
          </h1>
        </div>

        {/* --- MOVED & UPGRADED: STATUS & API KEYS DASHBOARD --- */}
        <div className="px-4 mb-6">
          <div className="bg-slate-800/80 rounded-xl p-4 border border-slate-700/50 shadow-inner">
             <div className="flex items-start justify-between">
                 <div>
                   <div className="flex items-center gap-2.5 mb-1.5">
                      {/* --- DYNAMIC BLINKING DOT --- */}
                      <div className="relative flex h-2.5 w-2.5">
                        <span className={`animate-ping absolute inline-flex h-full w-full rounded-full opacity-75 ${user && hasActiveKey ? 'bg-emerald-400' : 'bg-amber-400'}`}></span>
                        <span className={`relative inline-flex rounded-full h-2.5 w-2.5 ${user && hasActiveKey ? 'bg-emerald-500' : 'bg-amber-500'}`}></span>
                      </div>
                      
                      <span className={`text-[11px] font-bold uppercase tracking-wider ${user && hasActiveKey ? 'text-emerald-400' : 'text-amber-400'}`}>
                        {!user ? 'Connecting...' : !hasActiveKey ? 'Missing Key' : 'Connected'}
                      </span>
                   </div>
                   <p className="text-[10px] text-slate-400 leading-tight">
                     {!user ? 'Waiting for database' : !hasActiveKey ? `Add ${aiProvider === 'openai' ? 'OpenAI' : 'Gemini'} key to run` : 'Ready to transcribe'}
                   </p>
                 </div>
                 
                 <button 
                   onClick={() => setShowKeyDialog(true)}
                   className="p-1.5 bg-slate-700/50 hover:bg-blue-600 rounded-lg text-slate-300 hover:text-white transition-all shadow-sm"
                   title="Set API Keys"
                 >
                    <Key className="w-4 h-4" />
                 </button>
             </div>
             
             {/* If missing key, show a big Call to Action button */}
             {!hasActiveKey && user && (
               <button 
                 onClick={() => setShowKeyDialog(true)}
                 className="w-full mt-3 py-1.5 text-[11px] font-bold text-slate-900 bg-amber-400 hover:bg-amber-300 rounded transition-colors"
               >
                 Set API Key Now
               </button>
             )}
          </div>
        </div>

        <nav className="flex-1 overflow-y-auto px-4 pb-4 border-t border-slate-800/50 pt-4">
          <div className="flex items-center justify-between mb-4 px-2">
            <span className="text-xs font-bold uppercase tracking-widest text-slate-500">Projects</span>
            <button 
              onClick={() => setShowNewProjectInput(true)}
              className="p-1 hover:bg-slate-800 rounded text-blue-400 transition-colors"
            >
              <Plus className="w-4 h-4" />
            </button>
          </div>

          <div className="space-y-1">
            {showNewProjectInput && (
              <div className="px-2 pb-2">
                <div className="flex items-center gap-1 bg-slate-800 rounded p-1">
                  <input 
                    autoFocus
                    value={newProjectName}
                    onChange={(e) => setNewProjectName(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && createProject()}
                    className="bg-transparent border-none focus:ring-0 text-sm w-full px-2 py-1 text-white outline-none"
                    placeholder="Project name..."
                  />
                  <button onClick={createProject} className="p-1 text-emerald-400 hover:text-emerald-300">
                    <Check className="w-4 h-4" />
                  </button>
                  <button onClick={() => setShowNewProjectInput(false)} className="p-1 text-slate-400 hover:text-slate-200">
                    <XCircle className="w-4 h-4" />
                  </button>
                </div>
              </div>
            )}

            {projects.map((proj) => (
              <button
                key={proj.id}
                onClick={() => { setActiveProjectId(proj.id); setSelectedFileId(null); }}
                className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition-all group ${
                  activeProjectId === proj.id 
                    ? 'bg-blue-600 text-white shadow-lg shadow-blue-900/20 font-medium' 
                    : 'hover:bg-slate-800 text-slate-400 hover:text-slate-200'
                }`}
              >
                <Folder className={`w-4 h-4 ${activeProjectId === proj.id ? 'text-blue-100' : 'text-slate-500 group-hover:text-slate-300'}`} />
                <span className="truncate">{proj.name}</span>
              </button>
            ))}
          </div>
        </nav>
      </aside>

      <main className="flex-1 overflow-y-auto p-4 md:p-8">
        <div className="max-w-6xl mx-auto">
          {/* Header */}
          <header className="flex flex-col mb-8 gap-4 border-b border-slate-200 pb-6 relative">
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
              <div>
                <h2 className="text-2xl font-bold text-slate-900">
                  {projects.find(p => p.id === activeProjectId)?.name || 'Loading...'}
                </h2>
                <p className="text-slate-500 text-sm mt-1 flex items-center gap-1.5">
                  <History className="w-3.5 h-3.5" />
                  {files.length} / {MAX_FILES_PER_PROJECT} recording{files.length !== 1 ? 's' : ''} in this project
                </p>
              </div>
              
              <div className="flex flex-wrap gap-2 items-center">
                {hasCompletedFiles && (
                  <button 
                    onClick={downloadAllCombined}
                    className="px-4 py-2 bg-white border border-slate-200 text-slate-700 rounded-lg font-semibold hover:bg-slate-50 transition-all flex items-center gap-2 shadow-sm"
                  >
                    <Files className="w-4 h-4" />
                    <span className="hidden sm:inline">Export Project (.txt)</span>
                  </button>
                )}
                
                <div className="relative flex items-center bg-white border border-slate-200 rounded-lg shadow-sm pl-3 pr-1 py-1 h-10">
                  <Cpu className="w-4 h-4 text-slate-400 mr-2 shrink-0" />
                  <select 
                    value={aiProvider}
                    onChange={(e) => setAiProvider(e.target.value)}
                    disabled={isProcessing}
                    className="bg-transparent text-sm font-semibold text-slate-700 outline-none appearance-none pr-6 cursor-pointer disabled:opacity-50"
                  >
                    <option value="gemini">Gemini 2.5</option>
                    <option value="openai">OpenAI Whisper</option>
                  </select>
                </div>

                <button 
                  onClick={startBulkProcessing}
                  disabled={isProcessing || pendingFilesCount === 0}
                  className="px-6 py-2 bg-blue-600 text-white rounded-lg font-semibold hover:bg-blue-700 transition-all flex items-center gap-2 disabled:bg-slate-300 disabled:cursor-not-allowed shadow-md h-10"
                >
                  {isProcessing ? (
                    <><Loader2 className="w-4 h-4 animate-spin" /> Processing ({batchProgress.current}/{batchProgress.total})</>
                  ) : (
                    <><Play className="w-4 h-4 fill-current" /> Run {pendingFilesCount > 0 ? pendingFilesCount : ''}</>
                  )}
                </button>
              </div>
            </div>

            {batchProgress.total > 0 && (
              <div className="w-full mt-5">
                <div className="flex justify-between text-xs font-semibold text-slate-500 mb-1.5 px-0.5 uppercase tracking-wider">
                  <span>Batch Processing... (15s delay per file for Free Tier)</span>
                  <span>{Math.round((batchProgress.current / batchProgress.total) * 100)}%</span>
                </div>
                <div className="w-full bg-slate-200 rounded-full h-2.5 overflow-hidden">
                  <div 
                    className="bg-blue-500 h-2.5 rounded-full transition-all duration-300 ease-out" 
                    style={{ width: `${(batchProgress.current / batchProgress.total) * 100}%` }}
                  ></div>
                </div>
              </div>
            )}
          </header>

          {errorMessage && (
            <div className="mb-6 p-4 bg-amber-50 border border-amber-200 text-amber-800 rounded-xl flex items-start gap-3 animate-in fade-in slide-in-from-top-2">
              <AlertCircle className="w-5 h-5 mt-0.5 shrink-0" />
              <p className="text-sm">{errorMessage}</p>
              <button onClick={() => setErrorMessage(null)} className="ml-auto text-amber-500 hover:text-amber-700">
                <XCircle className="w-4 h-4" />
              </button>
            </div>
          )}

          <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
            <div className="lg:col-span-5 space-y-6">
              <div 
                className={`border-2 border-dashed rounded-2xl p-6 text-center transition-all cursor-pointer group shadow-sm
                  ${isDragging 
                    ? 'border-blue-500 bg-blue-50 scale-[1.02]' 
                    : 'border-slate-300 bg-white hover:border-blue-400 hover:bg-blue-50/50'
                  }
                  ${files.length >= MAX_FILES_PER_PROJECT ? 'opacity-50 pointer-events-none' : ''}
                `}
                onClick={() => files.length < MAX_FILES_PER_PROJECT && document.getElementById('audio-upload').click()}
                onDragEnter={handleDragOver}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
              >
                <input id="audio-upload" type="file" multiple accept="audio/*" className="hidden" onChange={handleFileChange} />
                <div className={`w-10 h-10 rounded-full flex items-center justify-center mx-auto mb-3 transition-transform ${isDragging ? 'bg-blue-200 scale-125' : 'bg-blue-100 group-hover:scale-110'}`}>
                  <Upload className="text-blue-600 w-5 h-5" />
                </div>
                <h3 className="text-md font-semibold text-slate-700">
                  {files.length >= MAX_FILES_PER_PROJECT ? 'Project Full' : isDragging ? 'Drop files here!' : `Add to ${projects.find(p => p.id === activeProjectId)?.name || 'Project'}`}
                </h3>
                <p className="text-xs text-slate-500 mt-1">
                  {files.length >= MAX_FILES_PER_PROJECT ? `Maximum ${MAX_FILES_PER_PROJECT} files reached.` : 'Drag and drop audio files, or click to browse.'}
                </p>
              </div>

              <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden flex flex-col min-h-[450px] shadow-sm">
                <div className="p-4 border-b border-slate-100 bg-slate-50/50 flex justify-between items-center">
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] font-bold uppercase tracking-widest text-slate-400">Queue & History</span>
                  </div>
                  {isSyncing && <Loader2 className="w-3 h-3 animate-spin text-blue-500" />}
                </div>
                
                <div className="flex-1 overflow-y-auto max-h-[500px]">
                  {files.length === 0 ? (
                    <div className="flex flex-col items-center justify-center h-full py-12 text-slate-300">
                      <FileAudio className="w-12 h-12 mb-3 opacity-20" />
                      <p className="text-sm">No files in this project</p>
                    </div>
                  ) : (
                    <ul className="divide-y divide-slate-100">
                      {sortedFiles.map((file) => (
                        <li 
                          key={file.id}
                          className={`group p-4 flex items-center gap-4 hover:bg-slate-50 transition-colors cursor-pointer ${selectedFileId === file.id ? 'bg-blue-50/50' : ''}`}
                          onClick={() => setSelectedFileId(file.id)}
                        >
                          <div className="relative shrink-0">
                            {file.status === 'completed' ? (
                              <CheckCircle2 className="text-emerald-500 w-5 h-5" />
                            ) : file.status === 'error' ? (
                              <XCircle className="text-rose-500 w-5 h-5" />
                            ) : file.status === 'processing' ? (
                              <Loader2 className="text-blue-500 w-5 h-5 animate-spin" />
                            ) : (
                              <div className="w-5 h-5 rounded-full border-2 border-slate-200" />
                            )}
                          </div>
                          
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium text-slate-900 truncate">{file.name}</p>
                            <div className="flex items-center gap-2 mt-0.5">
                              <span className="text-[10px] text-slate-400 uppercase font-medium">{file.size}</span>
                              {file.isRemote && (
                                <span className="text-[10px] text-emerald-600 bg-emerald-50 px-1.5 rounded flex items-center gap-0.5">
                                  <Cloud className="w-2 h-2" /> Sync
                                </span>
                              )}
                              {file.provider && (
                                 <span className="text-[10px] text-slate-400 uppercase font-medium flex items-center gap-0.5 ml-1">
                                   • {file.provider === 'openai' ? 'Whisper' : 'Gemini'}
                                 </span>
                              )}
                            </div>
                          </div>

                          <button 
                            onClick={(e) => { e.stopPropagation(); removeFile(file); }}
                            className="opacity-0 group-hover:opacity-100 p-2 text-slate-400 hover:text-red-500 transition-all"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            </div>

            <div className="lg:col-span-7">
              <div className="bg-white rounded-2xl border border-slate-200 h-full min-h-[600px] flex flex-col overflow-hidden shadow-sm">
                {!selectedFileData ? (
                  <div className="flex-1 flex flex-col items-center justify-center text-slate-400 p-12 text-center">
                    <div className="bg-slate-100 p-6 rounded-full mb-4">
                      <FileText className="w-10 h-10 text-slate-300" />
                    </div>
                    <h3 className="text-lg font-medium text-slate-600">View Transcript</h3>
                    <p className="text-sm max-w-xs mt-2 text-slate-400">Select a recording from the sidebar to view, copy, or download its generated text.</p>
                  </div>
                ) : (
                  <>
                    <div className="p-6 border-b border-slate-100 flex flex-col md:flex-row md:items-center justify-between gap-4">
                      <div className="min-w-0">
                        <h2 className="text-xl font-bold truncate text-slate-800">{selectedFileData.name}</h2>
                        <div className="flex items-center gap-2 mt-1">
                          <span className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase ${
                            selectedFileData.status === 'completed' ? 'bg-emerald-100 text-emerald-700' :
                            selectedFileData.status === 'error' ? 'bg-rose-100 text-rose-700' :
                            selectedFileData.status === 'processing' ? 'bg-blue-100 text-blue-700' : 'bg-slate-100 text-slate-600'
                          }`}>
                            {selectedFileData.status}
                          </span>
                          {selectedFileData.timestamp && (
                            <span className="text-[10px] text-slate-400 font-medium">
                              {new Date(selectedFileData.timestamp).toLocaleString()}
                            </span>
                          )}
                           {selectedFileData.provider && (
                            <span className="text-[10px] text-slate-400 font-bold uppercase">
                              • {selectedFileData.provider === 'openai' ? 'Whisper' : 'Gemini'}
                            </span>
                          )}
                        </div>
                      </div>
                      
                      {selectedFileData.status === 'completed' && (
                        <div className="flex gap-2">
                          <button 
                            onClick={() => copyToClipboard(selectedFileData.transcript)}
                            className="p-2 bg-slate-100 hover:bg-slate-200 rounded-lg text-slate-600 transition-colors"
                            title="Copy to clipboard"
                          >
                            <Copy className="w-4 h-4" />
                          </button>
                          <button 
                            onClick={() => downloadTranscript(selectedFileData)}
                            className="px-4 py-2 bg-blue-50 text-blue-600 hover:bg-blue-100 rounded-lg flex items-center gap-2 text-sm font-bold transition-colors shadow-sm"
                          >
                            <Download className="w-4 h-4" />
                            Download
                          </button>
                        </div>
                      )}
                    </div>

                    <div className="flex-1 p-6 overflow-y-auto bg-slate-50/30">
                      {selectedFileData.status === 'processing' ? (
                        <div className="flex flex-col items-center justify-center h-full space-y-4">
                          <Loader2 className="w-10 h-10 text-blue-500 animate-spin" />
                          <p className="text-slate-500 font-medium animate-pulse">Transcribing with {aiProvider === 'openai' ? 'Whisper' : 'Gemini'}...</p>
                        </div>
                      ) : selectedFileData.status === 'completed' ? (
                        <div className="flex flex-col gap-6 h-full">
                          {selectedFileData.file && (
                            <div className="bg-white border border-slate-200 p-3 rounded-xl shadow-sm flex flex-col gap-2 shrink-0">
                              <p className="text-xs font-bold text-slate-400 uppercase tracking-wider px-1">Audio Playback</p>
                              <audio 
                                controls 
                                className="w-full h-10 outline-none" 
                                src={URL.createObjectURL(selectedFileData.file)} 
                              />
                            </div>
                          )}
                          <div className="bg-white border border-slate-200 p-6 rounded-xl shadow-sm flex-1 overflow-y-auto">
                            <div className="prose prose-slate max-w-none">
                              <div className="whitespace-pre-wrap leading-relaxed text-slate-700 text-lg font-normal">
                                {selectedFileData.transcript}
                              </div>
                            </div>
                          </div>
                        </div>
                      ) : selectedFileData.status === 'error' ? (
                        <div className="bg-rose-50 border border-rose-100 p-6 rounded-xl text-rose-800">
                          <h4 className="font-bold flex items-center gap-2 mb-2"><XCircle className="w-5 h-5" /> Error</h4>
                          <p className="text-sm">{selectedFileData.error}</p>
                          <button 
                            onClick={startBulkProcessing}
                            className="mt-4 px-4 py-2 bg-rose-600 text-white rounded-lg text-sm font-medium"
                          >
                            Retry
                          </button>
                        </div>
                      ) : (
                        <div className="flex flex-col items-center justify-center h-full text-slate-400 italic">
                          <p>Upload is complete. Click "Run Transcription" to start.</p>
                        </div>
                      )}
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
};

export default App;