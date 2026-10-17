import os
import requests
from dotenv import load_dotenv

load_dotenv()
ELEVENLABS_API_KEY = os.getenv("ELEVENLABS_API_KEY")

def download_call_audio(conversation_id, save_folder="recordings"):
    """
    Downloads the audio recording of an ElevenLabs conversation and saves it locally.
    Returns the file path so it can be referenced in your email.
    """
    if not ELEVENLABS_API_KEY:
        print("❌ Error: ELEVENLABS_API_KEY is missing from the .env file.")
        return None

    # 1. Ensure the destination folder exists
    os.makedirs(save_folder, exist_ok=True)
    
    # 2. ElevenLabs Conversational AI Audio Endpoint
    url = f"https://api.elevenlabs.io/v1/convai/conversations/{conversation_id}/audio"
    
    headers = {
        "xi-api-key": ELEVENLABS_API_KEY
    }
    
    # 3. Request the audio data
    print(f"Downloading audio for call {conversation_id}...")
    response = requests.get(url, headers=headers)
    
    # 4. Save the file if the request was successful
    if response.status_code == 200:
        file_path = os.path.join(save_folder, f"{conversation_id}.mp3")
        
        # 'wb' means "write binary" (required for audio/images)
        with open(file_path, "wb") as audio_file:
            audio_file.write(response.content)
            
        print(f"✅ Audio successfully saved to {file_path}")
        return file_path
    else:
        print(f"❌ Failed to download audio. ElevenLabs says: {response.text}")
        return None

# ---- Test: only runs when you run THIS file directly ----
if __name__ == "__main__":
    # Replace with a real conversation ID from your voice team to test
    test_id = "your_test_conversation_id"
    download_call_audio(test_id)
