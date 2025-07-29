import { useState, useEffect, useRef } from 'react';
import Head from 'next/head';
import { useRouter } from 'next/router';
import { FiSend, FiFile, FiMessageSquare, FiChevronDown, FiUser, FiCpu } from 'react-icons/fi';
import { toast } from 'react-toastify';
import Layout from '../components/Layout';
import { getAuthHeader } from '../utils/auth';

export default function AudioChat() {
  const router = useRouter();
  const [isLoading, setIsLoading] = useState(true);
  const [files, setFiles] = useState([]);
  const [selectedFile, setSelectedFile] = useState('');
  const [messages, setMessages] = useState([]);
  const [inputMessage, setInputMessage] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [showFileSelector, setShowFileSelector] = useState(false);
  const messagesEndRef = useRef(null);
  const inputRef = useRef(null);

  // Fetch user's audio files on page load
  useEffect(() => {
    fetchUserFiles();
  }, []);

  // Scroll to bottom of messages
  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  // Focus input when file is selected
  useEffect(() => {
    if (selectedFile && inputRef.current) {
      inputRef.current.focus();
    }
  }, [selectedFile]);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event) => {
      if (showFileSelector && !event.target.closest('.file-selector')) {
        setShowFileSelector(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [showFileSelector]);

  // Auto-resize textarea
  const handleInputChange = (e) => {
    setInputMessage(e.target.value);
    
    // Reset height and set to scrollHeight
    e.target.style.height = 'auto';
    e.target.style.height = Math.min(e.target.scrollHeight, 200) + 'px';
  };

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  const fetchUserFiles = async () => {
    try {
      setIsLoading(true);
      const response = await fetch('/api/files/completed', {
        headers: getAuthHeader()
      });
      
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      
      const data = await response.json();
      
      // Only show files with transcripts
      const filesWithTranscripts = data.files.filter(file => 
        file.transcript && file.transcript.length > 0
      );
      
      setFiles(filesWithTranscripts);
      setIsLoading(false);
    } catch (error) {
      console.error('Error fetching files:', error);
      setIsLoading(false);
      toast.error('Failed to load your audio files');
    }
  };

  const handleFileSelect = async (fileId) => {
    if (fileId === selectedFile) return;
    
    setSelectedFile(fileId);
    setMessages([]);
    setShowFileSelector(false);
    
    const selectedFileObj = files.find(f => f.id === fileId);
    if (selectedFileObj) {
      // Add welcome message
      setMessages([
        {
          role: 'assistant',
          content: `Hi! I'm ready to discuss "${selectedFileObj.name}" with you. What would you like to know about this audio file?`
        }
      ]);
    }
  };

  const handleSendMessage = async () => {
    if (!inputMessage.trim() || !selectedFile) return;
    
    const newUserMessage = {
      role: 'user',
      content: inputMessage
    };
    
    setMessages(prev => [...prev, newUserMessage]);
    setInputMessage('');
    setIsProcessing(true);
    
    try {
      const selectedFileObj = files.find(f => f.id === selectedFile);
      
      const response = await fetch('/api/chat/audio-chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...getAuthHeader()
        },
        body: JSON.stringify({
          fileId: selectedFile,
          message: inputMessage,
          conversation: messages.filter(m => m.role !== 'system'),
          transcript: selectedFileObj.transcript
        })
      });
      
      if (!response.ok) {
        const errorResponse = await response.json().catch(() => null);
        const error = new Error(`HTTP error! status: ${response.status}`);
        error.response = response;
        error.responseData = errorResponse;
        throw error;
      }
      
      const data = await response.json();
      
      const assistantMessage = {
        role: 'assistant',
        content: data.reply || "I'm sorry, I couldn't process that request."
      };
      
      setMessages(prev => [...prev, assistantMessage]);
    } catch (error) {
      console.error('Chat error:', error);
      
      let errorMessage = "I'm sorry, I encountered an error processing your message. Please try again.";
      
      // Try to extract more detailed error information if available
      try {
        if (error.message.includes('HTTP error')) {
          const responseText = await error.response?.text();
          if (responseText) {
            const errorData = JSON.parse(responseText);
            if (errorData.error && typeof errorData.error === 'string') {
              errorMessage = `Error: ${errorData.error}`;
            }
            if (errorData.details) {
              console.error('Error details:', errorData.details);
            }
          }
        }
      } catch (parseError) {
        console.error('Error parsing error response:', parseError);
      }
      
      toast.error('Failed to process your message');
      
      // Add error message to the chat
      const errorResponseMessage = {
        role: 'assistant',
        content: errorMessage
      };
      setMessages(prev => [...prev, errorResponseMessage]);
    } finally {
      setIsProcessing(false);
    }
  };

  return (
    <Layout>
      <Head>
        <title>Chat with Audio | Kilo</title>
      </Head>
      
      <div className="flex flex-col h-screen bg-black">
        {/* Header */}
        <div className="flex-shrink-0 bg-black border-b border-gray-700">
          <div className="max-w-4xl mx-auto px-4 py-4">
            <div className="flex items-center justify-between">
              <h1 className="text-xl font-semibold text-white">Chat with Audio Files</h1>
              
              {/* File Selector */}
              <div className="relative file-selector">
                <button
                  onClick={() => setShowFileSelector(!showFileSelector)}
                  className="flex items-center space-x-2 px-4 py-2 bg-gray-800 hover:bg-gray-700 rounded-md transition-colors text-white border border-gray-600"
                >
                  <FiFile className="w-4 h-4" />
                  <span className="text-sm">
                    {selectedFile ? files.find(f => f.id === selectedFile)?.name || 'Select Audio File' : 'Select Audio File'}
                  </span>
                  <FiChevronDown className={`w-4 h-4 transition-transform ${showFileSelector ? 'rotate-180' : ''}`} />
                </button>
                
                {/* Dropdown */}
                {showFileSelector && (
                  <div className="absolute top-full right-0 mt-2 w-80 bg-gray-800 border border-gray-600 rounded-md shadow-lg z-50 max-h-64 overflow-y-auto">
                    {isLoading ? (
                      <div className="p-4 text-center">
                        <div className="animate-spin w-6 h-6 border-2 border-gray-500 border-t-transparent rounded-full mx-auto"></div>
                        <p className="mt-2 text-sm text-gray-400">Loading files...</p>
                      </div>
                    ) : files.length === 0 ? (
                      <div className="p-4 text-center">
                        <p className="text-sm text-gray-400">
                          No audio files found. Upload and process audio files to chat with them.
                        </p>
                      </div>
                    ) : (
                      <div className="py-2">
                        {files.map(file => (
                          <button
                            key={file.id}
                            className={`w-full text-left px-4 py-3 hover:bg-gray-700 ${
                              selectedFile === file.id ? "bg-gray-700" : ""
                            }`}
                            onClick={() => handleFileSelect(file.id)}
                          >
                            <div className="flex items-center space-x-3">
                              <FiFile className="w-4 h-4 text-gray-400" />
                              <div className="flex-1 min-w-0">
                                <p className="text-sm font-medium text-white truncate">{file.name}</p>
                                <p className="text-xs text-gray-400">
                                  {new Date(file.createdAt).toLocaleDateString()}
                                </p>
                              </div>
                            </div>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
        
        {/* Chat Area */}
        <div className="flex-1 flex flex-col min-h-0">
          {!selectedFile ? (
            /* Welcome Screen */
            <div className="flex-1 flex items-center justify-center bg-black">
              <div className="text-center max-w-md">
                <div className="w-16 h-16 bg-gray-800 rounded-full flex items-center justify-center mx-auto mb-4">
                  <FiMessageSquare className="w-8 h-8 text-gray-400" />
                </div>
                <h2 className="text-2xl font-semibold text-white mb-2">
                  Chat with Your Audio Files
                </h2>
                <p className="text-gray-400 mb-6">
                  Select an audio file from the dropdown above to start a conversation about its content.
                </p>
                <button
                  onClick={() => setShowFileSelector(true)}
                  className="inline-flex items-center px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white rounded-lg transition-colors border border-gray-600"
                >
                  <FiFile className="w-4 h-4 mr-2" />
                  Choose Audio File
                </button>
              </div>
            </div>
          ) : (
            <>
              {/* Messages Area */}
              <div className="flex-1 overflow-y-auto bg-black">
                <div className="max-w-4xl mx-auto px-4 py-6">
                  <div className="space-y-4">
                    {messages.filter(m => m.role !== 'system').map((message, index) => (
                      <div
                        key={index}
                        className={`flex items-start space-x-4 ${
                          message.role === 'user' ? 'justify-end' : 'justify-start'
                        }`}
                      >
                        {message.role === 'assistant' && (
                          <div className="flex-shrink-0 w-8 h-8 rounded-full bg-emerald-600 flex items-center justify-center">
                            <FiCpu className="w-4 h-4 text-white" />
                          </div>
                        )}
                        
                        {/* Message Content */}
                        <div className={`max-w-xs lg:max-w-md xl:max-w-lg ${
                          message.role === 'user' ? 'order-1' : 'order-2'
                        }`}>
                          <div className={`px-4 py-3 rounded-2xl ${
                            message.role === 'user'
                              ? 'bg-gray-700 text-white ml-auto'
                              : 'bg-gray-800 text-white'
                          }`}>
                            <p className="text-sm whitespace-pre-wrap">{message.content}</p>
                          </div>
                        </div>

                        {message.role === 'user' && (
                          <div className="flex-shrink-0 w-8 h-8 rounded-full bg-gray-600 flex items-center justify-center order-2">
                            <FiUser className="w-4 h-4 text-white" />
                          </div>
                        )}
                      </div>
                    ))}
                    
                    {/* Typing Indicator */}
                    {isProcessing && (
                      <div className="flex items-start space-x-4 justify-start">
                        <div className="flex-shrink-0 w-8 h-8 rounded-full bg-emerald-600 flex items-center justify-center">
                          <FiCpu className="w-4 h-4 text-white" />
                        </div>
                        <div className="max-w-xs lg:max-w-md xl:max-w-lg">
                          <div className="bg-gray-800 px-4 py-3 rounded-2xl">
                            <div className="flex space-x-1">
                              <div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce"></div>
                              <div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '0.1s' }}></div>
                              <div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '0.2s' }}></div>
                            </div>
                          </div>
                        </div>
                      </div>
                    )}
                    
                    <div ref={messagesEndRef}></div>
                  </div>
                </div>
              </div>
              
              {/* Input Area */}
              <div className="flex-shrink-0 bg-black px-4 py-6">
                <div className="max-w-3xl mx-auto">
                  <div className="relative">
                    <div className="flex items-center bg-gray-800 rounded-3xl border border-gray-600 shadow-lg">
                      {/* Input field */}
                      <div className="flex-1 relative px-4">
                        <textarea
                          ref={inputRef}
                          rows={1}
                          placeholder="Ask anything"
                          value={inputMessage}
                          onChange={handleInputChange}
                          onKeyPress={(e) => {
                            if (e.key === 'Enter' && !e.shiftKey) {
                              e.preventDefault();
                              handleSendMessage();
                            }
                          }}
                          disabled={isProcessing}
                          className="w-full resize-none bg-transparent py-3 text-white placeholder-gray-400 focus:outline-none disabled:opacity-50 text-base"
                          style={{ minHeight: '24px', maxHeight: '200px' }}
                        />
                      </div>
                      
                      {/* Send button */}
                      <div className="pr-4">
                        <button
                          onClick={handleSendMessage}
                          disabled={!inputMessage.trim() || isProcessing}
                          className={`p-2 rounded-full transition-colors ${
                            !inputMessage.trim() || isProcessing
                              ? "text-gray-500 cursor-not-allowed"
                              : "text-white bg-white/10 hover:bg-white/20"
                          }`}
                          aria-label="Send message"
                        >
                          <FiSend className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </Layout>
  );
}
