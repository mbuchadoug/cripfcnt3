<?php
// Set recipient email address
$to = 'deemcroots@gmail.com';

// Sanitize input data
$name = filter_var($_POST['name'], FILTER_SANITIZE_STRING);
$email = filter_var($_POST['email'], FILTER_SANITIZE_EMAIL);
$subject = filter_var($_POST['subject'], FILTER_SANITIZE_STRING);
$message = filter_var($_POST['message'], FILTER_SANITIZE_STRING);

// Validate email
if (!filter_var($email, FILTER_VALIDATE_EMAIL)) {
    http_response_code(400);
    echo json_encode(['result' => 'error', 'message' => 'Invalid email address']);
    exit;
}

// Prepare email headers
$headers = "From: $name <$email>\r\n";
$headers .= "Reply-To: $email\r\n";
$headers .= "MIME-Version: 1.0\r\n";
$headers .= "Content-Type: text/plain; charset=UTF-8\r\n";

// Build email content
$email_content = "Name: $name\n";
$email_content .= "Email: $email\n\n";
$email_content .= "Subject: $subject\n\n";
$email_content .= "Message:\n$message\n";

// Send email
$success = mail($to, $subject, $email_content, $headers);

// Return response
if ($success) {
    echo json_encode(['result' => 'success', 'message' => 'Message sent successfully!']);
} else {
    http_response_code(500);
    echo json_encode(['result' => 'error', 'message' => 'Failed to send message']);
}