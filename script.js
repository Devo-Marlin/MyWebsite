// wit for the DOM to be fully loaded// 
document.addEventListener("DOMContentLoaded", function() {
    // function to handle the email sign up form submission 
    const signupForm = document.getElementById("signup-form");
    const signupSuccessMessage = document.getElementById("signup-success");

    signupForm.addEventListener("submit", function(event) {
        event.preventDefault();

        //add your own logic here for handling submitted forms like displaying success message

        signupSuccessMessage.style.display = "block";
        signupForm.reset();
    });
});