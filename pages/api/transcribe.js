import formidable from 'formidable';
import fs from 'fs';
import { uploadFile, deleteFile } from '../../utils/storage.js';
import { verifyToken, getTokenFromRequest } from '../../utils/auth.js';
import { connectDB } from '../../lib/mongodb.js';
import { ObjectId } from 'mongodb';
import { 
  getAssemblyLanguageCode, 
  languageNeedsTranslation, 
  translateText, 
  getLanguageForAI,
  getAvailableFeatures 
} from '../../utils/languages.js';

export const config = {
  api: {
    bodyParser: false,
  },
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // Verify authentication
    const token = getTokenFromRequest(req);
    const decoded = verifyToken(token);
    
    if (!decoded) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // Find user in MongoDB
    const { db } = await connectDB();
    const user = await db.collection('users').findOne({ email: decoded.email });
    
    if (!user) {
      return res.status(401).json({ error: 'User not found' });
    }

    // Parse form data
    const form = formidable({
      maxFileSize: 500 * 1024 * 1024, // 500MB
      keepExtensions: true,
    });

    const [fields, files] = await form.parse(req);
    
    const file = files.file?.[0];
    if (!file) {
      console.error('❌ No file uploaded in request');
      return res.status(400).json({ 
        error: 'No file uploaded',
        errorType: 'VALIDATION_ERROR',
        details: 'files.file array is empty or undefined'
      });
    }

    console.log('📁 File details:', {
      originalFilename: file.originalFilename,
      mimetype: file.mimetype,
      size: file.size,
      filepath: file.filepath
    });

    // Validate file exists on disk
    if (!fs.existsSync(file.filepath)) {
      console.error('❌ File not found on disk:', file.filepath);
      return res.status(400).json({ 
        error: 'File not found on disk',
        errorType: 'FILE_NOT_FOUND',
        details: `Temporary file missing: ${file.filepath}`
      });
    }

    // Validate file type
    const supportedTypes = [
      'audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/m4a', 'audio/flac', 'audio/aac',
      'video/mp4', 'video/mov', 'video/avi', 'video/mkv', 'video/webm'
    ];
    
    if (!supportedTypes.includes(file.mimetype)) {
      console.error('❌ Unsupported file type:', file.mimetype);
      return res.status(400).json({ 
        error: 'Unsupported file type',
        errorType: 'INVALID_FILE_TYPE',
        details: `File type ${file.mimetype} not in supported types: ${supportedTypes.join(', ')}`
      });
    }

    // Validate file size (max 500MB)
    const maxSize = 500 * 1024 * 1024; // 500MB
    if (file.size > maxSize) {
      console.error('❌ File too large:', file.size);
      return res.status(400).json({ 
        error: 'File too large',
        errorType: 'FILE_TOO_LARGE',
        details: `File size ${file.size} bytes exceeds limit of ${maxSize} bytes`
      });
    }

    // Read file
    console.log('📖 Reading file from disk...');
    let fileBuffer;
    try {
      fileBuffer = fs.readFileSync(file.filepath);
      console.log('✅ File read successfully, buffer size:', fileBuffer.length);
    } catch (error) {
      console.error('❌ Error reading file:', error);
      return res.status(500).json({ 
        error: 'Failed to read file',
        errorType: 'FILE_READ_ERROR',
        details: error.message
      });
    }
    
    // Generate unique filename
    const timestamp = Date.now();
    const userId = user.id || user._id.toString();
    const fileName = `${userId}/${timestamp}_${file.originalFilename}`;
    
    console.log('☁️ Uploading to R2:', fileName);
    
    // Upload to R2
    let uploadResult;
    try {
      uploadResult = await uploadFile(fileBuffer, fileName, file.mimetype);
      console.log('✅ R2 upload result:', uploadResult);
    } catch (error) {
      console.error('❌ R2 upload error:', error);
      return res.status(500).json({ 
        error: 'Failed to upload file to storage',
        errorType: 'STORAGE_UPLOAD_ERROR',
        details: error.message
      });
    }
    
    if (!uploadResult.success) {
      console.error('❌ R2 upload failed:', uploadResult);
      return res.status(500).json({ 
        error: 'Failed to upload file to storage',
        errorType: 'STORAGE_UPLOAD_FAILED',
        details: uploadResult.error || 'Unknown storage error'
      });
    }

    // Get transcription settings
    const settings = {
      language: fields.language?.[0] || 'en',
      quality: fields.quality?.[0] || 'standard',
      speakerIdentification: fields.speakerIdentification?.[0] === 'true',
      includeTimestamps: fields.includeTimestamps?.[0] === 'true',
      filterProfanity: fields.filterProfanity?.[0] === 'true',
      autoPunctuation: fields.autoPunctuation?.[0] === 'true',
    };

    console.log('⚙️ Transcription settings:', settings);

    // Create file record in MongoDB
    const fileRecord = {
      userId: userId,
      name: file.originalFilename,
      size: file.size,
      type: file.mimetype,
      url: uploadResult.url,
      key: uploadResult.key,
      status: 'processing',
      settings,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    console.log('💾 Creating MongoDB record:', { ...fileRecord, userId: 'REDACTED' });

    let result;
    try {
      result = await db.collection('files').insertOne(fileRecord);
      console.log('✅ MongoDB record created:', result.insertedId);
    } catch (error) {
      console.error('❌ MongoDB insert error:', error);
      // Try to clean up uploaded file
      try {
        await deleteFile(uploadResult.key);
        console.log('🧹 Cleaned up uploaded file after DB error');
      } catch (deleteError) {
        console.error('❌ Failed to clean up file:', deleteError);
      }
      return res.status(500).json({ 
        error: 'Failed to save file record',
        errorType: 'DATABASE_ERROR',
        details: error.message
      });
    }

    const fileId = result.insertedId.toString();

    // Start transcription process (async)
    console.log('🎯 Starting transcription process for file:', fileId);
    try {
      processTranscription(fileId, uploadResult.url, settings);
      console.log('✅ Transcription process initiated');
    } catch (error) {
      console.error('❌ Error starting transcription:', error);
      // Don't return error here as file is already saved
    }

    // Clean up temp file
    try {
      fs.unlinkSync(file.filepath);
      console.log('🧹 Temporary file cleaned up:', file.filepath);
    } catch (error) {
      console.error('⚠️ Warning: Failed to clean up temp file:', error);
      // Don't return error as this is not critical
    }

    res.status(200).json({
      success: true,
      fileId: fileId,
      message: 'File uploaded and transcription started',
    });

  } catch (error) {
    console.error('Upload error details:', {
      message: error.message,
      stack: error.stack,
      name: error.name,
      timestamp: new Date().toISOString()
    });
    
    // Return more specific error information
    const errorResponse = {
      error: 'Upload failed',
      details: error.message || 'Unknown error occurred',
      errorType: error.name || 'Error',
      timestamp: new Date().toISOString(),
    };
    
    // Add environment check details for debugging
    const missingConfigs = [];
    if (!process.env.ASSEMBLYAI_API_KEY) missingConfigs.push('ASSEMBLYAI_API_KEY');
    if (!process.env.R2_ACCESS_KEY_ID) missingConfigs.push('R2_ACCESS_KEY_ID');
    if (!process.env.R2_SECRET_ACCESS_KEY) missingConfigs.push('R2_SECRET_ACCESS_KEY');
    if (!process.env.R2_ACCOUNT_ID) missingConfigs.push('R2_ACCOUNT_ID');
    if (!process.env.R2_BUCKET_NAME) missingConfigs.push('R2_BUCKET_NAME');
    if (!process.env.MONGODB_URI) missingConfigs.push('MONGODB_URI');
    
    if (missingConfigs.length > 0) {
      errorResponse.missingConfig = missingConfigs;
    }
    
    // Specific error handling
    if (error.message.includes('upload')) {
      errorResponse.error = 'File upload to storage failed';
      errorResponse.details = 'Check R2 configuration and network connectivity';
    } else if (error.message.includes('database') || error.message.includes('mongodb')) {
      errorResponse.error = 'Database connection failed';
      errorResponse.details = 'Check MongoDB connection string and database access';
    } else if (error.message.includes('form')) {
      errorResponse.error = 'File processing failed';
      errorResponse.details = 'Invalid file format or corrupted upload';
    }
    
    res.status(500).json(errorResponse);
  }
}

async function processTranscription(fileId, fileUrl, settings) {
  try {
    // Update status to processing
    const { db } = await connectDB();
    await db.collection('files').updateOne(
      { _id: new ObjectId(fileId) },
      { 
        $set: { 
          status: 'processing',
          updatedAt: new Date() 
        } 
      }
    );

    // Get the correct AssemblyAI language code
    const assemblyLanguageCode = getAssemblyLanguageCode(settings.language);
    const needsTranslation = languageNeedsTranslation(settings.language);
    const availableFeatures = getAvailableFeatures(settings.language);

    // Force translation if user wants non-English output (even for natively supported languages)
    const forceTranslation = settings.language !== 'en';

    console.log(`Processing transcription for language: ${settings.language} (Assembly: ${assemblyLanguageCode}, Needs Translation: ${needsTranslation}, Force Translation: ${forceTranslation})`);
    console.log(`Available features:`, availableFeatures);

    // Build request body with only supported features
    const requestBody = {
      audio_url: fileUrl,
      language_code: assemblyLanguageCode,
      format_text: availableFeatures.format_text,
    };

    // Only add features that are supported for this language
    if (availableFeatures.speaker_labels && settings.speakerIdentification) {
      requestBody.speaker_labels = true;
    }

    if (availableFeatures.auto_chapters) {
      requestBody.auto_chapters = true;
    }

    if (availableFeatures.filter_profanity && settings.filterProfanity) {
      requestBody.filter_profanity = true;
    }

    if (availableFeatures.punctuate && settings.autoPunctuation) {
      requestBody.punctuate = true;
    }

    // Add word-level timestamps if requested
    if (settings.includeTimestamps) {
      // No special parameter needed - utterances and words are included by default
      // We'll access them from statusData.utterances and statusData.words
    }
    
    console.log('Sending request to AssemblyAI with body:', requestBody);

    // Submit to AssemblyAI
    const assemblyResponse = await fetch('https://api.assemblyai.com/v2/transcript', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.ASSEMBLYAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody),
    });

    const transcriptData = await assemblyResponse.json();
    
    if (!transcriptData.id) {
      console.error('AssemblyAI submission failed:', transcriptData);
      throw new Error(`Failed to submit to AssemblyAI: ${transcriptData.error || 'Unknown error'}`);
    }

    console.log(`AssemblyAI job submitted with ID: ${transcriptData.id}`);

    // Poll for completion
    let isComplete = false;
    let attempts = 0;
    const maxAttempts = 120; // 10 minutes max

    while (!isComplete && attempts < maxAttempts) {
      await new Promise(resolve => setTimeout(resolve, 5000)); // Wait 5 seconds
      
      const statusResponse = await fetch(`https://api.assemblyai.com/v2/transcript/${transcriptData.id}`, {
        headers: {
          'Authorization': `Bearer ${process.env.ASSEMBLYAI_API_KEY}`,
        },
      });

      const statusData = await statusResponse.json();
      console.log(`Transcription status check ${attempts + 1}: ${statusData.status}`);
      
      if (statusData.status === 'completed') {
        isComplete = true;
        
        let finalTranscript = statusData.text;
        
        // Translate transcript if needed OR if user wants non-English output
        if ((needsTranslation || forceTranslation) && finalTranscript && settings.language !== 'en') {
          console.log(`🔄 TRANSLATING TRANSCRIPT: needsTranslation=${needsTranslation}, forceTranslation=${forceTranslation}, language=${settings.language}`);
          console.log(`📝 Original transcript length: ${finalTranscript.length} characters`);
          try {
            const translatedTranscript = await translateText(finalTranscript, settings.language, assemblyLanguageCode);
            console.log(`✅ Translation completed. New length: ${translatedTranscript.length} characters`);
            finalTranscript = translatedTranscript;
          } catch (translateError) {
            console.error(`❌ Translation failed:`, translateError);
          }
        } else {
          console.log(`⏭️ SKIPPING TRANSCRIPT TRANSLATION: needsTranslation=${needsTranslation}, forceTranslation=${forceTranslation}, language=${settings.language}, hasTranscript=${!!finalTranscript}`);
        }
        
        // Get AI summary in the target language
        const summary = await generateSummary(finalTranscript, settings.language);
        
        // Process timestamps/utterances
        let timestampData = [];
        if (settings.includeTimestamps) {
          console.log('Processing timestamps. StatusData utterances:', statusData.utterances?.length || 0);
          console.log('StatusData words:', statusData.words?.length || 0);
          
          if (statusData.utterances && statusData.utterances.length > 0) {
            timestampData = statusData.utterances.map(utterance => ({
              text: utterance.text,
              start: utterance.start,
              end: utterance.end,
              speaker: utterance.speaker || 'Speaker'
            }));
            console.log(`Processed ${timestampData.length} timestamp entries`);
            
            // Translate timestamp text if needed OR if user wants non-English output
            if ((needsTranslation || forceTranslation) && timestampData.length > 0 && settings.language !== 'en') {
              console.log(`🔄 TRANSLATING TIMESTAMPS (from utterances): ${timestampData.length} entries from ${assemblyLanguageCode} to ${settings.language}`);
              for (let i = 0; i < timestampData.length; i++) {
                try {
                  const originalText = timestampData[i].text;
                  const translatedText = await translateText(originalText, settings.language, assemblyLanguageCode);
                  timestampData[i].text = translatedText;
                  console.log(`✅ Timestamp ${i + 1}/${timestampData.length} translated`);
                } catch (error) {
                  console.error(`❌ Failed to translate timestamp ${i + 1}:`, error);
                  // Keep original text if translation fails
                }
              }
              console.log(`✅ All timestamp translations completed`);
            } else {
              console.log(`⏭️ SKIPPING TIMESTAMP TRANSLATION (utterances): needsTranslation=${needsTranslation}, forceTranslation=${forceTranslation}, timestampCount=${timestampData.length}, language=${settings.language}`);
            }
            
          } else if (statusData.words && statusData.words.length > 0) {
            // Fallback: create utterances from words if utterances are not available
            let currentUtterance = '';
            let currentStart = null;
            let currentEnd = null;
            
            statusData.words.forEach((word, index) => {
              if (currentStart === null) currentStart = word.start;
              currentEnd = word.end;
              currentUtterance += word.text + ' ';
              
              // Create utterances every 10 seconds or at sentence boundaries
              if (word.text.endsWith('.') || word.text.endsWith('!') || word.text.endsWith('?') || 
                  (currentEnd - currentStart) > 10000 || index === statusData.words.length - 1) {
                timestampData.push({
                  text: currentUtterance.trim(),
                  start: currentStart,
                  end: currentEnd,
                  speaker: 'Speaker'
                });
                currentUtterance = '';
                currentStart = null;
              }
            });
            console.log(`Created ${timestampData.length} timestamp entries from words`);
            
            // Translate timestamp text if needed OR if user wants non-English output
            if ((needsTranslation || forceTranslation) && timestampData.length > 0 && settings.language !== 'en') {
              console.log(`🔄 TRANSLATING TIMESTAMPS (from words): ${timestampData.length} entries from ${assemblyLanguageCode} to ${settings.language}`);
              for (let i = 0; i < timestampData.length; i++) {
                try {
                  const originalText = timestampData[i].text;
                  const translatedText = await translateText(originalText, settings.language, assemblyLanguageCode);
                  timestampData[i].text = translatedText;
                  console.log(`✅ Timestamp ${i + 1}/${timestampData.length} translated`);
                } catch (error) {
                  console.error(`❌ Failed to translate timestamp ${i + 1}:`, error);
                  // Keep original text if translation fails
                }
              }
              console.log('Timestamp translation completed');
            }
            
          } else {
            console.warn('No utterances or words data available for timestamps');
          }
        }

        // Update file with results
        await db.collection('files').updateOne(
          { _id: new ObjectId(fileId) },
          {
            $set: {
              status: 'completed',
              transcript: finalTranscript,
              summary: summary.summary,
              topic: summary.topic,
              topics: summary.topics,
              insights: summary.insights,
              speakers: statusData.speaker_labels ? extractSpeakers(statusData.utterances) : [],
              timestamps: timestampData,
              duration: statusData.audio_duration,
              wordCount: statusData.words?.length || 0,
              language: settings.language, // Store the original language choice
              updatedAt: new Date(),
            }
          }
        );

        // Update user stats in MongoDB
        const fileRecord = await db.collection('files').findOne({ _id: new ObjectId(fileId) });
        const dbUser = await db.collection('users').findOne({ 
          $or: [
            { id: fileRecord.userId },
            { _id: { $eq: fileRecord.userId } }
          ]
        });
        
        if (dbUser) {
          await db.collection('users').updateOne(
            { _id: dbUser._id },
            {
              $inc: {
                transcriptionsCount: 1,
                minutesUsed: Math.ceil(statusData.audio_duration / 60)
              }
            }
          );
        }

        break;
      } else if (statusData.status === 'error') {
        throw new Error(statusData.error || 'Transcription failed');
      }
      
      attempts++;
    }

    if (!isComplete) {
      throw new Error('Transcription timeout');
    }

  } catch (error) {
    console.error('Transcription processing error:', error);
    try {
      const { db } = await connectDB();
      await db.collection('files').updateOne(
        { _id: new ObjectId(fileId) },
        {
          $set: {
            status: 'error',
            error: error.message,
            updatedAt: new Date(),
          }
        }
      );
    } catch (updateError) {
      console.error('Error updating file status:', updateError);
    }
  }
}

async function generateSummary(text, targetLanguage = 'en') {
  try {
    // Take a subset of the transcript if it's too long
    const maxTranscriptLength = 32000;
    const truncatedText = text.length > maxTranscriptLength 
      ? text.substring(0, maxTranscriptLength) 
      : text;
    
    // Get the language name for the AI prompt
    const languageName = getLanguageForAI(targetLanguage);
    
    // Create prompt in the target language
    const summaryPrompt = `Analyze this transcript and respond in ${languageName}:\n\n"${truncatedText}"\n\nProvide your response in ${languageName} with:\n1. SUMMARY: A 2-3 sentence summary in ${languageName}.\n2. TOPICS: 3-5 main topics in ${languageName}, comma-separated.\n3. INSIGHTS: 1-2 key insights in ${languageName}.\n\nFormat your response exactly like this:\nSUMMARY: [Your summary in ${languageName}]\nTOPICS: [topic1, topic2 in ${languageName}]\nINSIGHTS: [Your insights in ${languageName}]`;
    
    console.log(`Generating AI summary in ${languageName} for language code: ${targetLanguage}`);
    
    // Using Gemini API
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1/models/gemini-1.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ 
          contents: [{ 
            parts: [{ 
              text: summaryPrompt 
            }] 
          }] 
        })
      }
    );
    
    if (!response.ok) {
      const errorText = await response.text();
      console.error('Gemini API error:', response.status, response.statusText);
      console.error('Error response:', errorText);
      throw new Error(`Gemini API error: ${response.status}`);
    }
    
    const data = await response.json();
    
    if (data.error) {
      console.error('Gemini error details:', data.error);
      throw new Error('Failed to generate summary with Gemini');
    }
    
    const generatedText = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    
    console.log('AI summary generated successfully in', languageName);
    
    // Parse the response
    let summary = targetLanguage === 'en' ? "AI-generated summary not available" : await translateText("AI-generated summary not available", targetLanguage, 'en');
    let topics = [targetLanguage === 'en' ? "General Discussion" : await translateText("General Discussion", targetLanguage, 'en')];
    let insights = targetLanguage === 'en' ? "No insights available" : await translateText("No insights available", targetLanguage, 'en');
    
    // Parse response using regex patterns
    const summaryMatch = generatedText.match(/SUMMARY:\s*(.+?)(?=TOPICS:|$)/s);
    const topicsMatch = generatedText.match(/TOPICS:\s*(.+?)(?=INSIGHTS:|$)/s);
    const insightsMatch = generatedText.match(/INSIGHTS:\s*(.+?)$/s);
    
    if (summaryMatch) summary = summaryMatch[1].trim();
    if (topicsMatch) topics = topicsMatch[1].trim().split(",").map(t => t.trim()).filter(Boolean);
    if (insightsMatch) insights = insightsMatch[1].trim();
    
    return {
      summary: summary,
      topic: topics[0] || (targetLanguage === 'en' ? 'General' : await translateText('General', targetLanguage, 'en')),
      topics: topics,
      insights: insights
    };
  } catch (error) {
    console.error('Summary generation error:', error);
    
    // Return default values in the target language
    const defaultSummary = targetLanguage === 'en' ? 
      "AI-generated summary not available" : 
      await translateText("AI-generated summary not available", targetLanguage, 'en').catch(() => "AI-generated summary not available");
    
    const defaultTopic = targetLanguage === 'en' ? 
      "General" : 
      await translateText("General", targetLanguage, 'en').catch(() => "General");
    
    const defaultTopics = targetLanguage === 'en' ? 
      ["General Discussion"] : 
      [await translateText("General Discussion", targetLanguage, 'en').catch(() => "General Discussion")];
    
    const defaultInsights = targetLanguage === 'en' ? 
      "No insights available" : 
      await translateText("No insights available", targetLanguage, 'en').catch(() => "No insights available");
    
    return {
      summary: defaultSummary,
      topic: defaultTopic,
      topics: defaultTopics,
      insights: defaultInsights
    };
  }
}

function extractSpeakers(utterances) {
  if (!utterances || !Array.isArray(utterances)) return [];
  
  const speakers = new Set();
  utterances.forEach(utterance => {
    if (utterance.speaker) {
      speakers.add(utterance.speaker);
    }
  });
  
  return Array.from(speakers);
}
