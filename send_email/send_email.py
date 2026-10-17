import os
import smtplib
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from dotenv import load_dotenv

load_dotenv()
SMTP_SERVER = "smtp.gmail.com"
SMTP_PORT = 587
EMAIL_USER = os.getenv("SENDER_EMAIL")
EMAIL_PASS = os.getenv("SENDER_APP_PASSWORD")

def send_verification_email(html_body, recipient_email):
    """Sends the summary email to the hackathon judge."""
    if not EMAIL_USER or not EMAIL_PASS:
        print("❌ Error: Sender credentials missing in .env file.")
        return False

    msg = MIMEMultipart("alternative")
    msg["Subject"] = "✅ AutoBooker AI: Final Reservation Secured"
    msg["From"] = EMAIL_USER
    msg["To"] = recipient_email

    part = MIMEText(html_body, "html")
    msg.attach(part)

    try:
        server = smtplib.SMTP(SMTP_SERVER, SMTP_PORT)
        server.starttls()
        server.login(EMAIL_USER, EMAIL_PASS)
        server.sendmail(EMAIL_USER, recipient_email, msg.as_string())
        server.quit()
        
        print(f"✅ Success: Verification email sent to {recipient_email}!")
        return True
    
    except Exception as e:
        print(f"❌ Failed to send email: {e}")
        return False

# ---- Test: only runs when you run THIS file directly ----
if __name__ == "__main__":
    target_inbox = os.getenv("HACKATHON_JUDGE_EMAIL")
    test_html = "<h2>Test Email</h2><p>Testing the outbound sender.</p>"
    send_verification_email(test_html, target_inbox)
