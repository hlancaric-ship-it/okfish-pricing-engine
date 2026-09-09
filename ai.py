#!/usr/bin/env python3
import sys
import os
import requests

GROQ_API_KEY = os.environ.get("GROQ_API_KEY")

def main():
    if not GROQ_API_KEY:
        print("CHYBA: Není nastavená proměnná prostředí GROQ_API_KEY.")
        print("Nastav ji příkazem: export GROQ_API_KEY='tvuj_klíč'")
        sys.exit(1)

    if len(sys.argv) < 2:
        print("Použití: python3 ai.py \"Tvůj dotaz nebo úkol pro kód\"")
        sys.exit(1)

    prompt = sys.argv[1]
    
    url = "https://api.groq.com/openai/v1/chat/completions"
    headers = {
        "Authorization": f"Bearer {GROQ_API_KEY}",
        "Content-Type": "application/json"
    }
    payload = {
        "model": "openai/gpt-oss-20b",
        "messages": [
            {"role": "system", "content": "Jsi špičkový senior software developer. Odpovídej stručně, čistě a k věci (česky, pokud není řečeno jinak)."},
            {"role": "user", "content": prompt}
        ],
        "temperature": 0.2
    }

    try:
        response = requests.post(url, json=payload, headers=headers)
        if response.status_code != 200:
            print(f"API chyba [{response.status_code}]: {response.text}")
            return
        
        data = response.json()
        answer = data["choices"][0]["message"]["content"]
        print("\n--- AI Výstup ---")
        print(answer)
        print("-----------------\n")
    except Exception as e:
        print(f"Chyba při komunikaci s cloudem: {e}")

if __name__ == "__main__":
    main()
